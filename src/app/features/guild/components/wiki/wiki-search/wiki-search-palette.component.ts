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
    ViewChild,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {WikiDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {WikiContentCacheService} from '../wiki-content-cache.service';
import {searchWiki} from '../wiki-search';

/**
 * ⌘K over the wiki.
 *
 * Titles and tags are searchable with zero requests, so results appear on the first keystroke.
 * Page bodies are opt-in: one `includeContent` request, taken only when asked for. The footer
 * always states which of the two you are actually getting - presenting title-only results under
 * a full-text banner would misreport what was searched.
 */
@Component({
    selector: 'app-wiki-search-palette',
    imports: [FormsModule],
    templateUrl: './wiki-search-palette.component.html',
})
export class WikiSearchPaletteComponent implements AfterViewInit {
    readonly open = input(false);
    readonly wiki = input<WikiDto | null>(null);
    readonly guildId = input.required<string>();

    readonly closed = output<void>();
    readonly pageSelected = output<WikiPageSummaryDto>();

    @ViewChild('queryInput') queryInput?: ElementRef<HTMLInputElement>;

    protected readonly query = signal('');
    protected readonly activeIndex = signal(0);
    protected readonly cache = inject(WikiContentCacheService);

    protected readonly results = computed(() => {
        const pages = this.wiki()?.pages ?? [];
        const content = this.cache.content();
        const byId = new Map(pages.map(p => [p.id, p]));
        return searchWiki(
            pages.map(p => ({id: p.id, title: p.title, tags: p.tags, content: content.get(p.id)})),
            this.query(),
        ).map(hit => ({hit, page: byId.get(hit.id)!})).filter(r => !!r.page);
    });

    protected readonly categoryNames = computed(() => {
        const wiki = this.wiki();
        return new Map((wiki?.categories ?? []).map(c => [c.id, c.name]));
    });

    constructor() {
        // Reopening with the previous query still in the box, and the previous selection still
        // highlighted, reads as a stuck dialog.
        effect(() => {
            if (this.open()) {
                this.query.set('');
                this.activeIndex.set(0);
                setTimeout(() => this.queryInput?.nativeElement.focus(), 0);
            }
        });

        effect(() => {
            this.query();
            this.activeIndex.set(0);
        });
    }

    ngAfterViewInit(): void {
        if (this.open()) this.queryInput?.nativeElement.focus();
    }

    protected onKeydown(event: KeyboardEvent): void {
        const items = this.results();
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
            if (chosen) this.choose(chosen.page);
        }
    }

    protected choose(page: WikiPageSummaryDto): void {
        this.pageSelected.emit(page);
        this.closed.emit();
    }

    /** Content coverage is opt-in: one request, taken only when asked for. */
    protected searchContents(): void {
        this.cache.warm(this.guildId());
    }
}
