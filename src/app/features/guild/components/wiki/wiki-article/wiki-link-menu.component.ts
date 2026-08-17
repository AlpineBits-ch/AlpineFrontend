import {Component, computed, input, output, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {searchWiki} from '../wiki-search';

/** The [[ page picker; reuses the same ranking as the command palette so "[[set" and a Cmd+K search for "set" surface pages in the same order. */
@Component({
    selector: 'app-wiki-link-menu',
    imports: [NgClass, TranslateModule],
    template: `
        @if (open()) {
            <div
                [style.left.px]="position().left"
                [style.top.px]="position().top"
                class="fixed z-50 w-64 overflow-hidden rounded-xl border border-border bg-card
                        py-1 shadow-xl"
            >
                @for (page of matches(); track page.id; let i = $index) {
                    <button
                        (click)="selected.emit(page)"
                        [ngClass]="
                            i === activeIndex()
                                ? 'bg-brand/25 ring-1 ring-inset ring-brand/40'
                                : 'hover:bg-hover'
                        "
                        class="flex w-full cursor-pointer items-center gap-2.5 border-0
                                   bg-transparent px-3 py-2 text-left text-[0.8125rem]
                                   text-text-primary"
                    >
                        <i class="pi pi-file text-[0.75rem] text-text-muted"></i>
                        <span class="truncate">{{ page.title }}</span>
                    </button>
                }
                @if (matches().length === 0) {
                    <p class="px-3 py-2 text-[0.75rem] text-text-muted">
                        {{ 'WIKI.LINK_MENU.NO_MATCH' | translate }}
                    </p>
                }
            </div>
        }
    `,
})
export class WikiLinkMenuComponent {
    readonly open = input(false);
    readonly query = input('');
    readonly position = input<{top: number; left: number}>({top: 0, left: 0});
    readonly pages = input<readonly WikiPageSummaryDto[]>([]);

    readonly selected = output<WikiPageSummaryDto>();

    protected readonly activeIndex = signal(0);

    /** An empty query lists pages, so `[[` is useful before you have typed anything. */
    protected readonly matches = computed(() => {
        const pages = this.pages();
        const query = this.query();
        if (!query.trim()) return [...pages].slice(0, 8);
        const byId = new Map(pages.map(p => [p.id, p]));
        return searchWiki(
            pages.map(p => ({id: p.id, title: p.title, tags: p.tags})),
            query,
            8,
        )
            .map(hit => byId.get(hit.id))
            .filter((p): p is WikiPageSummaryDto => !!p);
    });

    handleKey(key: string): boolean {
        if (!this.open()) return false;
        const items = this.matches();
        if (key === 'ArrowDown') {
            this.activeIndex.update(i => (i + 1) % Math.max(1, items.length));
            return true;
        }
        if (key === 'ArrowUp') {
            this.activeIndex.update(i => (i - 1 + items.length) % Math.max(1, items.length));
            return true;
        }
        if (key === 'Enter') {
            const page = items[this.activeIndex()];
            if (page) this.selected.emit(page);
            return true;
        }
        return false;
    }

    reset(): void {
        this.activeIndex.set(0);
    }
}
