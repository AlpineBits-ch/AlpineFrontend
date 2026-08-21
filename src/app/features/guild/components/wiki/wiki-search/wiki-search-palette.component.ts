import {
    AfterViewInit,
    Component,
    computed,
    effect,
    ElementRef,
    inject,
    input,
    output,
    signal,
    viewChild,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Select} from 'primeng/select';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {WikiDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../../services/wiki.service';
import {ProfileService} from '../../../../../services/profile.service';
import {ToastService} from '../../../../../services/toast.service';
import {WikiContentCacheService} from '../wiki-content-cache.service';
import {hasActiveFilters, SearchFilters, SearchHit, searchWiki, wikiPagePath} from '../wiki-search';
import {WikiSearchRecentsService} from './wiki-search-recents.service';

/** One row of the palette. Modelled as a union so one arrow-key handler drives all three kinds. */
export type PaletteRow =
    | {kind: 'page'; page: WikiPageSummaryDto; hit: SearchHit; path: string[]}
    | {kind: 'create'; title: string}
    | {kind: 'recent'; query: string};

/**
 * ⌘K over the wiki. Titles and tags are searchable with zero requests, so results appear on the
 * first keystroke. Page bodies are opt-in: one `includeContent` request, taken only when asked
 * for. The footer always states which of the two you are actually getting: presenting title-only
 * results under a full-text banner would misreport what was searched. A query that matches nothing
 * offers to create the page.
 */
@Component({
    selector: 'app-wiki-search-palette',
    imports: [FormsModule, Select, TranslateModule],
    templateUrl: './wiki-search-palette.component.html',
})
export class WikiSearchPaletteComponent implements AfterViewInit {
    readonly open = input(false);
    readonly wiki = input<WikiDto | null>(null);
    readonly guildId = input.required<string>();
    /** Fails closed: without an explicit grant the palette never offers to create a page. */
    readonly canCreate = input(false);

    readonly closed = output<void>();
    readonly pageSelected = output<WikiPageSummaryDto>();

    readonly queryInput = viewChild<ElementRef<HTMLInputElement>>('queryInput');

    protected readonly query = signal('');
    protected readonly activeIndex = signal(0);
    protected readonly creating = signal(false);
    protected readonly filtersOpen = signal(false);
    protected readonly tagFilter = signal<string | undefined>(undefined);
    protected readonly categoryFilter = signal<string | undefined>(undefined);
    protected readonly authorFilter = signal<string | undefined>(undefined);

    protected readonly cache = inject(WikiContentCacheService);
    protected readonly recents = inject(WikiSearchRecentsService);

    protected readonly filters = computed<SearchFilters>(() => ({
        tag: this.tagFilter(),
        categoryId: this.categoryFilter(),
        authorId: this.authorFilter(),
    }));

    protected readonly activeFilterCount = computed(
        () => [this.tagFilter(), this.categoryFilter(), this.authorFilter()].filter(Boolean).length,
    );

    protected readonly results = computed(() => {
        const wiki = this.wiki();
        const pages = wiki?.pages ?? [];
        const content = this.cache.content();
        const byId = new Map(pages.map(p => [p.id, p]));
        return searchWiki(
            pages.map(p => ({
                id: p.id,
                title: p.title,
                tags: p.tags,
                content: content.get(p.id),
                categoryId: p.categoryId,
                authorId: p.authorId,
            })),
            this.query(),
            25,
            this.filters(),
        )
            .map(hit => ({hit, page: byId.get(hit.id)!}))
            .filter(r => !!r.page)
            .map(r => ({
                ...r,
                path: wikiPagePath(r.page.id, pages, wiki?.categories ?? []),
            }));
    });

    /** Results, plus the two things that are not results: recent queries when there is nothing to search yet, and the create action when nothing matched what was typed. */
    protected readonly rows = computed<PaletteRow[]>(() => {
        const typed = this.query().trim();
        const results = this.results();
        const rows: PaletteRow[] = results.map(r => ({
            kind: 'page' as const,
            page: r.page,
            hit: r.hit,
            path: r.path,
        }));

        if (!typed && !hasActiveFilters(this.filters())) {
            return this.recents.recent().map(q => ({kind: 'recent' as const, query: q}));
        }

        // Offered only when nothing already carries that exact title: otherwise the action invites a duplicate of the page sitting one row above it.
        const exists = results.some(r => r.page.title.toLowerCase() === typed.toLowerCase());
        if (typed && this.canCreate() && !exists) rows.push({kind: 'create', title: typed});
        return rows;
    });

    protected readonly tagOptions = computed(() => {
        const tags = new Set<string>();
        for (const page of this.wiki()?.pages ?? []) for (const tag of page.tags) tags.add(tag);
        return [...tags].sort((a, b) => a.localeCompare(b)).map(t => ({label: t, value: t}));
    });

    protected readonly categoryOptions = computed(() =>
        [...(this.wiki()?.categories ?? [])]
            .sort((a, b) => a.position - b.position)
            .map(c => ({label: c.name, value: c.id})),
    );

    protected readonly authorOptions = computed(() => {
        const ids = new Set((this.wiki()?.pages ?? []).map(p => p.authorId).filter(Boolean));
        return [...ids]
            .map(id => ({
                label:
                    this.profileService.getCachedByUserId(id)?.userName ??
                    this.translate.instant('WIKI.SEARCH.UNKNOWN_AUTHOR'),
                value: id,
            }))
            .sort((a, b) => a.label.localeCompare(b.label));
    });

    private readonly wikiService = inject(WikiService);
    private readonly profileService = inject(ProfileService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    constructor() {
        // Reopening with the previous query still in the box, and the previous selection still highlighted, reads as a stuck dialog.
        effect(() => {
            if (this.open()) {
                this.query.set('');
                this.activeIndex.set(0);
                // Filters left armed from last time would silently hide results the next search should have found.
                this.clearFilters();
                this.filtersOpen.set(false);
                setTimeout(() => this.queryInput()?.nativeElement.focus(), 0);
            }
        });

        effect(() => {
            this.query();
            this.filters();
            this.activeIndex.set(0);
        });

        effect(() => {
            const guildId = this.guildId();
            if (guildId) this.recents.load(guildId);
        });

        // The author filter is a list of names, not of user ids, so the profiles have to be in hand before the dropdown is opened rather than after.
        effect(() => {
            if (!this.filtersOpen()) return;
            for (const page of this.wiki()?.pages ?? []) {
                if (page.authorId) this.profileService.resolveByUserId(page.authorId);
            }
        });
    }

    ngAfterViewInit(): void {
        if (this.open()) this.queryInput()?.nativeElement.focus();
    }

    protected onKeydown(event: KeyboardEvent): void {
        const items = this.rows();
        if (event.key === 'Escape') {
            event.preventDefault();
            this.closed.emit();
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            this.activeIndex.update(i => (i + 1) % Math.max(1, items.length));
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            this.activeIndex.update(i => (i - 1 + items.length) % Math.max(1, items.length));
        } else if (event.key === 'Enter') {
            event.preventDefault();
            const chosen = items[this.activeIndex()];
            if (chosen) this.activate(chosen);
        }
    }

    protected activate(row: PaletteRow): void {
        if (row.kind === 'page') this.choose(row.page);
        else if (row.kind === 'create') this.createPage(row.title);
        else this.applyRecent(row.query);
    }

    protected choose(page: WikiPageSummaryDto): void {
        // Recorded here rather than on keystroke: a query is only worth remembering once it has proven it leads somewhere.
        this.recents.record(this.query());
        this.pageSelected.emit(page);
        this.closed.emit();
    }

    protected applyRecent(query: string): void {
        this.query.set(query);
        this.queryInput()?.nativeElement.focus();
    }

    protected clearFilters(): void {
        this.tagFilter.set(undefined);
        this.categoryFilter.set(undefined);
        this.authorFilter.set(undefined);
    }

    /** Content coverage is opt-in: one request, taken only when asked for. */
    protected searchContents(): void {
        this.cache.warm(this.guildId());
    }

    /** Creates the page and opens it. Done here rather than handed to the editor as a prefilled title, since the editor has no such input, and a palette that dropped the user into an empty "Untitled" would have thrown away what they'd already typed. */
    protected createPage(title: string): void {
        const guildId = this.guildId();
        if (!title.trim() || !this.canCreate() || this.creating() || !guildId) return;
        this.creating.set(true);
        this.wikiService
            .createPage(guildId, {
                title: title.trim(),
                content: '',
                // A filtered search says where the user is looking; the new page belongs there.
                categoryId: this.categoryFilter(),
            })
            .subscribe({
                next: page => {
                    this.creating.set(false);
                    this.recents.record(title);
                    this.pageSelected.emit(page);
                    this.closed.emit();
                },
                error: () => {
                    this.creating.set(false);
                    this.toast.error(this.translate.instant('WIKI.SEARCH.CREATE_FAILED'));
                },
            });
    }
}
