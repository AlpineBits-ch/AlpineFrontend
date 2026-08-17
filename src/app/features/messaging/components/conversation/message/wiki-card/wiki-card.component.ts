import {ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {DatePipe, NgClass} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {forkJoin} from 'rxjs';
import {ProfileService} from '../../../../../../services/profile.service';
import {WikiCategoryDto} from '../../../../../../dtos/response/wiki.dto';
import {MessageEmbed} from '../../../../../../dtos/response/message.dto';
import {WikiDeepLinkService} from '../../../../../guild/components/wiki/wiki-share/wiki-deep-link.service';
import {categoryPath, WikiPagePreview, WikiPagePreviewService} from './wiki-page-preview.service';
import {wikiSnippet} from '../../../../wiki-link';

/** A wiki page linked from a message, rendered from the server's `venta.wiki_page` embed. */
@Component({
    selector: 'app-wiki-card',
    imports: [DatePipe, NgClass, TranslateModule],
    templateUrl: './wiki-card.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WikiCardComponent {
    readonly embed = input.required<MessageEmbed>();

    protected readonly preview = signal<WikiPagePreview | null>(null);
    protected readonly categories = signal<WikiCategoryDto[]>([]);
    /** Guards the lazy read so a card scrolled past twice does not ask twice. */
    private readonly requested = signal(false);

    protected readonly guildId = computed(() => this.embed().venta?.guild_id ?? '');
    protected readonly pageId = computed(() => this.embed().venta?.page_id ?? '');
    protected readonly url = computed(() => this.embed().url ?? '');

    protected readonly snippet = computed(() => wikiSnippet(this.preview()?.page.content ?? ''));

    protected readonly trail = computed(() =>
        categoryPath(this.categories(), this.preview()?.page.categoryId));

    /**
     * Who touched it last. `lastEditorId` is absent on a page nobody has edited since it was
     * written, where the author *is* the last editor - so the fallback is the truth, not a guess.
     */
    protected readonly editorName = computed(() => {
        const page = this.preview()?.page;
        if (!page) return '';
        const userId = page.lastEditorId ?? page.authorId;
        return this.profileService.getCachedByUserId(userId)?.userName ?? '';
    });

    /** Whether clicking could land anywhere: we are in that guild and its Wiki module is on. */
    protected readonly reachable = computed(() =>
        !!this.guildId() && this.deepLink.canOpen(this.guildId()));

    private readonly previews = inject(WikiPagePreviewService);
    private readonly profileService = inject(ProfileService);
    private readonly deepLink = inject(WikiDeepLinkService);
    private readonly destroyRef = inject(DestroyRef);

    /** Fills in the page's own name for this viewer. */
    protected resolveTitle(): void {
        if (this.requested() || !this.guildId() || !this.pageId()) return;
        this.requested.set(true);

        forkJoin({
            preview: this.previews.preview(this.guildId(), this.pageId()),
            categories: this.previews.categoriesFor(this.guildId()),
        }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            // A refusal keeps the placeholder. `preview` is already null for any failure, which is
            // the same outcome a 403 and a 404 must both have here.
            next: ({preview, categories}) => {
                if (!preview) return;
                this.preview.set(preview);
                this.categories.set(categories);
                // Fills `editorName` on the next tick. Nothing waits on it: a card with no name yet
                // simply omits the byline rather than holding the title back for it.
                this.profileService.resolveByUserId(preview.page.lastEditorId ?? preview.page.authorId);
            },
            error: () => undefined,
        });
    }

    protected open(): void {
        const page = this.preview()?.page;
        if (!this.reachable()) return;
        this.deepLink.open(this.guildId(), page?.id ?? this.pageId());
    }
}
