import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Component, computed, effect, inject, input, OnDestroy, output, signal} from '@angular/core';
import {WikiDto, WikiPageDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {ProfileService} from '../../../../../services/profile.service';
import {WikiService} from '../../../../../services/wiki.service';
import {AppAvatarComponent} from '../../../../../components/avatar/avatar.component';
import {WikiContentCacheService} from '../wiki-content-cache.service';
import {WikiStateService} from '../wiki-state.service';
import {canEditPage} from '../wiki-permissions';
import {
    buildBacklinkIndex,
    findUnlinkedMentions,
    linkFirstMention,
    UnlinkedMention,
    wikiHref,
} from '../wiki-links';
import {activeHeadingIndex, buildToc, Heading, headingElementsIn, TocEntry} from '../wiki-toc';
import {pageStats} from './wiki-page-stats';
import {WikiRailSectionComponent} from './wiki-rail-section.component';
import {WikiPagePropertiesComponent} from './wiki-page-properties.component';

/** The rendered document, which ProseMirror owns and this component only reads. */
const ARTICLE_BODY = '.wiki-article-body';

/** How far below the top of the article a heading counts as the one being read. */
const READING_LINE_OFFSET = 96;

/** Enough mentions to act on; a common word as a page title would otherwise fill the rail. */
const MENTION_LIMIT = 10;

const COPIED_FEEDBACK_MS = 1500;

interface MentionRow {
    mention: UnlinkedMention;
    source: WikiPageSummaryDto;
}

/**
 * The right rail: page properties, table of contents, links in and out, attribution. It is also
 * what fills the dead gutter beside the article's readable-width clamp on a wide window.
 */
@Component({
    selector: 'app-wiki-context-rail',
    imports: [AppAvatarComponent, TranslateModule, WikiRailSectionComponent, WikiPagePropertiesComponent],
    templateUrl: './wiki-context-rail.component.html',
    host: {class: 'flex flex-col h-full min-h-0'},
})
export class WikiContextRailComponent implements OnDestroy {
    readonly page = input<WikiPageDto | null>(null);
    readonly wiki = input<WikiDto | null>(null);
    readonly guildId = input.required<string>();
    readonly headings = input<readonly Heading[]>([]);
    /** An override for the scroll spy below; left unbound the rail tracks the reader itself, which is what it does today, since nothing has ever fed this input. */
    readonly activeHeadingId = input<string | null>(null);
    /** The body as it stands in the editor right now, so word count moves while typing rather than reporting whatever was last published. */
    readonly liveContent = input<string | null>(null);

    readonly tocEntrySelected = output<TocEntry>();
    readonly openPage = output<WikiPageSummaryDto>();

    protected readonly cache = inject(WikiContentCacheService);
    protected readonly state = inject(WikiStateService);
    private readonly profileService = inject(ProfileService);
    private readonly wikiService = inject(WikiService);
    private readonly translate = inject(TranslateService);

    /** The entry whose link was just copied, so the button can say so for a moment. */
    protected readonly copiedId = signal<string | null>(null);
    protected readonly linkingId = signal<string | null>(null);
    protected readonly linkFailedId = signal<string | null>(null);

    /** Where the reader is, when nothing has been fed to `activeHeadingId`. */
    private readonly spyHeadingId = signal<string | null>(null);
    private scrollFrame = 0;
    private copiedTimer?: ReturnType<typeof setTimeout>;

    /** Below two headings a table of contents is noise, not navigation. */
    protected readonly toc = computed(() => {
        const entries = buildToc(this.headings());
        return entries.length >= 2 ? entries : [];
    });

    protected readonly currentHeadingId = computed(() => this.activeHeadingId() ?? this.spyHeadingId());

    /** Counted from the live editor body when there is one, so the figure is what the page will be rather than what it was. `||` and not `??`: an editor that hasn't mounted yet reports an empty string, and that is not a page with no words in it. */
    protected readonly stats = computed(() => pageStats(this.liveContent() || this.page()?.content || ''));

    protected readonly backlinks = computed(() => {
        const pageId = this.page()?.id;
        if (!pageId) return [];
        const sources = buildBacklinkIndex(this.cache.content()).get(pageId) ?? [];
        const byId = new Map((this.wiki()?.pages ?? []).map(p => [p.id, p]));
        return sources.map(id => byId.get(id)).filter((p): p is WikiPageSummaryDto => !!p);
    });

    /** Pages that name this one and never link it: the other half of "what points here", and the half a wiki actually grows from. */
    protected readonly unlinkedMentions = computed<MentionRow[]>(() => {
        const page = this.page();
        if (!page) return [];
        const byId = new Map((this.wiki()?.pages ?? []).map(p => [p.id, p]));
        return findUnlinkedMentions({id: page.id, title: page.title}, this.cache.content())
            .map(mention => ({mention, source: byId.get(mention.sourceId)}))
            .filter((row): row is MentionRow => !!row.source)
            .sort(
                (a, b) => b.mention.count - a.mention.count || a.source.title.localeCompare(b.source.title),
            );
    });

    protected readonly visibleMentions = computed(() => this.unlinkedMentions().slice(0, MENTION_LIMIT));

    protected readonly hiddenMentionCount = computed(() =>
        Math.max(0, this.unlinkedMentions().length - MENTION_LIMIT),
    );

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
        // Backlinks need every page body, so opening the rail is what pays for the warm, not wiki load, for a panel the user may never look at.
        effect(() => {
            const guildId = this.guildId();
            if (guildId) this.cache.warm(guildId);
        });

        // Resolves the author and last editor so the rail can show their avatars.
        effect(() => {
            const page = this.page();
            if (page?.authorId) this.profileService.resolveByUserId(page.authorId);
            if (page?.lastEditorId) this.profileService.resolveByUserId(page.lastEditorId);
        });

        // A new document has new headings in new places, and the highlight must not keep pointing at a section of the page before it. Deferred a tick, since headings arrive from the editor before the DOM that holds them has been laid out.
        effect(() => {
            this.toc();
            setTimeout(() => this.syncActiveHeading());
        });

        // Capture phase on the document, because scroll does not bubble and the element that scrolls belongs to the article, not to the rail.
        document.addEventListener('scroll', this.onScroll, true);
    }

    ngOnDestroy(): void {
        document.removeEventListener('scroll', this.onScroll, true);
        cancelAnimationFrame(this.scrollFrame);
        clearTimeout(this.copiedTimer);
    }

    /** Copies a link to one section. `wiki:<pageId>#<slug>` rather than a URL: it is the same href the editor writes for a page link, so pasting it into a page produces a working link with no new syntax to teach anybody. */
    protected copySectionLink(entry: TocEntry, event: MouseEvent): void {
        event.stopPropagation();
        const pageId = this.page()?.id;
        if (!pageId) return;
        navigator.clipboard.writeText(wikiHref(pageId, entry.id)).then(
            () => {
                this.copiedId.set(entry.id);
                clearTimeout(this.copiedTimer);
                this.copiedTimer = setTimeout(() => this.copiedId.set(null), COPIED_FEEDBACK_MS);
            },
            // A denied clipboard is not worth a dialog; the button simply does not confirm.
            () => this.copiedId.set(null),
        );
    }

    protected canLink(source: WikiPageSummaryDto): boolean {
        return canEditPage(this.state.abilities(), source.authorId, this.state.ownUserId());
    }

    /** Turns the first plain mention on another page into a link to this one. The body is re-read from the server rather than taken from the cache: the cache exists to make backlinks cheap, not to be written back, and a body gone stale between the warm and this click would silently revert whoever edited it in between. */
    protected linkMention(row: MentionRow): void {
        const target = this.page();
        if (!target || this.linkingId() || !this.canLink(row.source)) return;
        const guildId = this.guildId();
        this.linkFailedId.set(null);
        this.linkingId.set(row.source.id);

        this.wikiService.getPage(guildId, row.source.id).subscribe({
            next: fresh => {
                const content = fresh.content ?? '';
                const linked = linkFirstMention(content, target.title, target.id);
                if (!linked) {
                    // The mention is gone from the current body. Refreshing the cache drops the row rather than leaving a button that does nothing.
                    this.cache.put(fresh.id, content);
                    this.linkingId.set(null);
                    return;
                }
                this.wikiService
                    .updatePage(guildId, row.source.id, {
                        content: linked,
                        summary: this.translate.instant('WIKI.RAIL.LINK_SUMMARY', {title: target.title}),
                    })
                    .subscribe({
                        next: saved => {
                            this.cache.put(saved.id, saved.content);
                            this.linkingId.set(null);
                        },
                        error: () => this.failLink(row.source.id),
                    });
            },
            error: () => this.failLink(row.source.id),
        });
    }

    protected formatDate(date: Date | string): string {
        return new Date(date).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    }

    private failLink(sourceId: string): void {
        this.linkingId.set(null);
        this.linkFailedId.set(sourceId);
    }

    private readonly onScroll = (): void => {
        // One measurement per frame. Scroll fires far more often than that, and each pass reads layout for every heading in the document.
        cancelAnimationFrame(this.scrollFrame);
        this.scrollFrame = requestAnimationFrame(() => this.syncActiveHeading());
    };

    /** Which entry to highlight, from where the rendered headings currently sit. Matched by position rather than by id, so it works whether or not anything has stamped ids onto the document: `buildToc` emits in document order, so the Nth element is the Nth entry. */
    private syncActiveHeading(): void {
        const entries = this.toc();
        const elements = headingElementsIn(document.querySelector(ARTICLE_BODY));
        if (!entries.length || !elements.length) {
            this.spyHeadingId.set(null);
            return;
        }
        const line = scrollTopOf(elements[0]) + READING_LINE_OFFSET;
        const tops = elements.map(element => element.getBoundingClientRect().top);
        const index = activeHeadingIndex(tops, line);
        this.spyHeadingId.set(index < 0 ? null : entries[Math.min(index, entries.length - 1)].id);
    }
}

/** The viewport position of the top of whatever scrolls the article. Found by walking up for an actual scrolling ancestor rather than by matching a class name: the rail does not own that markup and must not break when its utility classes change. */
function scrollTopOf(element: HTMLElement): number {
    for (let node = element.parentElement; node; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowY;
        if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
            return node.getBoundingClientRect().top;
        }
    }
    return 0;
}
