import {Component, computed, effect, inject, input, output} from '@angular/core';
import {WikiDto, WikiPageDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {ProfileService} from '../../../../../services/profile.service';
import {AppAvatarComponent} from '../../../../../components/avatar/avatar.component';
import {WikiContentCacheService} from '../wiki-content-cache.service';
import {buildBacklinkIndex} from '../wiki-links';
import {buildToc, Heading, TocEntry} from '../wiki-toc';

/**
 * The right rail: table of contents, backlinks and attribution.
 *
 * It is also what makes the layout work. The article clamps to a readable measure, and on a wide
 * window that used to leave a dead gutter; the rail is what now occupies it.
 */
@Component({
    selector: 'app-wiki-context-rail',
    imports: [AppAvatarComponent],
    templateUrl: './wiki-context-rail.component.html',
    host: {class: 'flex flex-col h-full min-h-0'},
})
export class WikiContextRailComponent {
    readonly page = input<WikiPageDto | null>(null);
    readonly wiki = input<WikiDto | null>(null);
    readonly guildId = input.required<string>();
    readonly headings = input<readonly Heading[]>([]);
    readonly activeHeadingId = input<string | null>(null);

    readonly tocEntrySelected = output<TocEntry>();
    readonly openPage = output<WikiPageSummaryDto>();

    protected readonly cache = inject(WikiContentCacheService);
    private readonly profileService = inject(ProfileService);

    /** Below two headings a table of contents is noise, not navigation. */
    protected readonly toc = computed(() => {
        const entries = buildToc(this.headings());
        return entries.length >= 2 ? entries : [];
    });

    protected readonly backlinks = computed(() => {
        const pageId = this.page()?.id;
        if (!pageId) return [];
        const sources = buildBacklinkIndex(this.cache.content()).get(pageId) ?? [];
        const byId = new Map((this.wiki()?.pages ?? []).map(p => [p.id, p]));
        return sources.map(id => byId.get(id)).filter((p): p is WikiPageSummaryDto => !!p);
    });

    protected readonly author = computed(() => {
        const id = this.page()?.authorId;
        return id ? this.profileService.getCachedByUserId(id) : undefined;
    });

    protected readonly lastEditor = computed(() => {
        const id = this.page()?.lastEditorId;
        if (!id || id === this.page()?.authorId) return undefined;
        return this.profileService.getCachedByUserId(id);
    });

    constructor() {
        // Backlinks need every page body, so opening the rail is what pays for the warm - not
        // wiki load, for a panel the user may never look at.
        effect(() => {
            const guildId = this.guildId();
            if (guildId) this.cache.warm(guildId);
        });

        // authorId and lastEditorId have been in the DTO since the feature shipped and were
        // never rendered. Resolving them here is what finally puts a face on a page.
        effect(() => {
            const page = this.page();
            if (page?.authorId) this.profileService.resolveByUserId(page.authorId);
            if (page?.lastEditorId) this.profileService.resolveByUserId(page.lastEditorId);
        });
    }

    protected formatDate(date: Date | string): string {
        return new Date(date).toLocaleDateString('en-US', {
            year: 'numeric', month: 'short', day: 'numeric',
        });
    }
}
