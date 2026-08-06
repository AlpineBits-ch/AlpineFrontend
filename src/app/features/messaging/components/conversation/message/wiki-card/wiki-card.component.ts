import {ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, OnInit, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {DatePipe, NgClass} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {forkJoin} from 'rxjs';
import {ProfileService} from '../../../../../../services/profile.service';
import {WikiCategoryDto} from '../../../../../../dtos/response/wiki.dto';
import {WikiDeepLinkService} from '../../../../../guild/components/wiki/wiki-share/wiki-deep-link.service';
import {categoryPath, WikiPagePreview, WikiPagePreviewService} from './wiki-page-preview.service';
import {wikiSnippet} from '../../../../wiki-link';

type CardState = 'loading' | 'ready' | 'error';

/**
 * A wiki page linked from a message, rendered as the page rather than as its URL.
 *
 * <p>Modelled on the invite card: the message carries an id, the card resolves it, and a failure
 * degrades to one muted line instead of an empty box. The body is stripped to plain text on the way
 * in - see `wikiSnippet` - so a wiki page can never render markup inside a conversation it was only
 * mentioned in.</p>
 */
@Component({
    selector: 'app-wiki-card',
    imports: [DatePipe, NgClass, TranslateModule],
    templateUrl: './wiki-card.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WikiCardComponent implements OnInit {
    guildId = input.required<string>();
    pageId = input.required<string>();

    protected readonly cardState = signal<CardState>('loading');
    protected readonly preview = signal<WikiPagePreview | null>(null);
    protected readonly categories = signal<WikiCategoryDto[]>([]);

    protected readonly snippet = computed(() => {
        const content = this.preview()?.page.content ?? '';
        return wikiSnippet(content);
    });

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
    protected readonly reachable = computed(() => this.deepLink.canOpen(this.guildId()));

    private readonly previews = inject(WikiPagePreviewService);
    private readonly profileService = inject(ProfileService);
    private readonly deepLink = inject(WikiDeepLinkService);
    private readonly destroyRef = inject(DestroyRef);

    ngOnInit(): void {
        forkJoin({
            preview: this.previews.preview(this.guildId(), this.pageId()),
            categories: this.previews.categoriesFor(this.guildId()),
        }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next: ({preview, categories}) => {
                if (!preview) {
                    this.cardState.set('error');
                    return;
                }
                this.preview.set(preview);
                this.categories.set(categories);
                this.cardState.set('ready');
                // Fills `editorName` on the next tick. Nothing waits on it: a card with no name yet
                // simply omits the byline rather than holding the title back for it.
                this.profileService.resolveByUserId(preview.page.lastEditorId ?? preview.page.authorId);
            },
            error: () => this.cardState.set('error'),
        });
    }

    protected open(): void {
        const page = this.preview()?.page;
        if (!page) return;
        this.deepLink.open(this.guildId(), page.id);
    }
}
