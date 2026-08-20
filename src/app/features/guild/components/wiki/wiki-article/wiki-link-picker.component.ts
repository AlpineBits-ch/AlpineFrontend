import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    ElementRef,
    input,
    output,
    signal,
    untracked,
    viewChild,
    viewChildren,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {NgClass} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {searchWiki} from '../wiki-search';
import {anchorTo, AnchorRect, injectWikiFloating} from './wiki-floating';
import {headingsFromMarkdown, normaliseExternalHref} from './wiki-link-target';

/** Which surface the picker is showing. */
export type WikiLinkPickerTab = 'page' | 'url';

/** What to apply. The caller writes the mark; this component never touches the document. */
export type WikiLinkResult =
    {kind: 'page'; pageId: string; headingId: string | null; title: string} | {kind: 'url'; href: string};

/** One row in the flat list the arrow keys index. */
interface PickerRow {
    id: string;
    kind: 'page' | 'heading';
    pageId: string;
    headingId: string | null;
    title: string;
    level: number;
}

const MAX_PAGES = 6;
const MAX_HEADINGS = 4;
const PANEL = {width: 320, height: 340};

/**
 * The one link surface, for all three ways of asking for a link: the toolbar button, the
 * configurable shortcut, and the `[[` trigger.
 *
 * The page tab is the writer for the `headingId` half of `wikiHref`, which until now had only
 * readers. The URL tab exists so a typed `example.com` becomes an absolute https link instead of
 * a relative one that resolves against the app's own origin.
 */
@Component({
    selector: 'app-wiki-link-picker',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [FormsModule, NgClass, TranslateModule],
    template: `
        @if (open()) {
            <div
                #panel
                (mousedown)="$event.stopPropagation()"
                [style.left.px]="position().left"
                [style.top.px]="position().top"
                class="fixed z-50 flex w-80 flex-col overflow-hidden rounded-xl border border-border
                        bg-card shadow-xl"
            >
                <div class="flex items-center gap-1 border-b border-border-subtle px-1 pt-1" role="tablist">
                    @for (entry of tabs; track entry.tab) {
                        <button
                            (click)="selectTab(entry.tab)"
                            [attr.aria-selected]="tab() === entry.tab"
                            [ngClass]="
                                tab() === entry.tab
                                    ? 'text-text-primary border-brand'
                                    : 'text-text-muted border-transparent hover:text-text-secondary'
                            "
                            class="cursor-pointer border-0 border-b-2 bg-transparent px-2.5 py-1.5
                                       text-[0.75rem] font-medium"
                            role="tab"
                            type="button"
                        >
                            {{ entry.labelKey | translate }}
                        </button>
                    }
                </div>

                @if (tab() === 'page') {
                    <div class="flex items-center gap-2 px-3 py-2">
                        <i class="pi pi-search text-[0.75rem] text-text-muted"></i>
                        <input
                            #queryInput
                            (ngModelChange)="onQuery($event)"
                            [attr.aria-activedescendant]="activeOptionId()"
                            [attr.aria-controls]="listboxId"
                            [attr.aria-expanded]="true"
                            [ngModel]="queryText()"
                            [placeholder]="'WIKI.LINK_PICKER.SEARCH_PLACEHOLDER' | translate"
                            aria-autocomplete="list"
                            class="w-full border-0 bg-transparent text-[0.8125rem] text-text-primary
                                      outline-none placeholder-white/25"
                            role="combobox"
                        />
                    </div>
                    <div
                        [attr.aria-activedescendant]="activeOptionId()"
                        [id]="listboxId"
                        class="thin-scrollbar max-h-64 overflow-y-auto pb-1"
                        role="listbox"
                    >
                        @for (row of rows(); track row.id; let i = $index) {
                            <button
                                #rowEl
                                (click)="chooseRow(row)"
                                [attr.aria-selected]="i === activeIndex()"
                                [id]="row.id"
                                [ngClass]="
                                    i === activeIndex()
                                        ? 'bg-brand/25 ring-1 ring-inset ring-brand/40'
                                        : 'hover:bg-hover'
                                "
                                [style.padding-left.rem]="row.kind === 'heading' ? 1.75 : 0.75"
                                class="flex w-full cursor-pointer items-center gap-2.5 border-0
                                           bg-transparent py-1.5 pr-3 text-left"
                                role="option"
                                type="button"
                            >
                                <i
                                    [class]="row.kind === 'page' ? 'pi-file' : 'pi-hashtag'"
                                    class="pi shrink-0 text-[0.75rem] text-text-muted"
                                ></i>
                                <span
                                    [ngClass]="
                                        row.kind === 'page' ? 'text-text-primary' : 'text-text-secondary'
                                    "
                                    class="truncate text-[0.8125rem]"
                                >
                                    {{ row.title }}
                                </span>
                            </button>
                        }
                        @if (rows().length === 0) {
                            <p class="px-3 py-2 text-[0.75rem] text-text-muted">
                                {{ 'WIKI.LINK_MENU.NO_MATCH' | translate }}
                            </p>
                        }
                    </div>
                } @else {
                    <div class="flex flex-col gap-2 p-3">
                        <input
                            #urlInput
                            (keydown.enter)="applyUrl()"
                            (ngModelChange)="hrefText.set($event)"
                            [ngModel]="hrefText()"
                            class="w-full rounded-lg border border-border bg-app-bg px-2 py-1.5
                                      text-[0.8125rem] text-text-primary outline-none
                                      placeholder-white/25"
                            placeholder="https://example.com"
                        />
                        @if (urlProblem()) {
                            <p class="text-[0.6875rem] leading-snug text-offline">
                                {{ 'WIKI.LINK_PICKER.URL_BLOCKED' | translate }}
                            </p>
                        } @else if (urlPreview(); as preview) {
                            <p class="truncate text-[0.6875rem] text-text-muted">{{ preview }}</p>
                        }
                        <div class="flex items-center gap-1">
                            <button
                                (click)="applyUrl()"
                                class="cursor-pointer rounded border-0 bg-brand/20 px-2 py-1
                                           text-[0.6875rem] font-medium text-brand-dim hover:bg-brand/30"
                                type="button"
                            >
                                {{ 'WIKI.TOOLBAR.LINK_APPLY' | translate }}
                            </button>
                            <button
                                (click)="removed.emit()"
                                class="cursor-pointer border-0 bg-transparent px-1 text-[0.6875rem]
                                           text-text-muted hover:text-text-primary"
                                type="button"
                            >
                                {{ 'WIKI.TOOLBAR.LINK_REMOVE' | translate }}
                            </button>
                        </div>
                    </div>
                }

                <div class="border-t border-border-subtle px-3 py-1.5 text-[0.625rem] text-text-muted">
                    {{ 'WIKI.LINK_PICKER.HINT' | translate }}
                </div>
            </div>
        }
    `,
})
export class WikiLinkPickerComponent {
    readonly open = input(false);
    /** Which tab to open on. The `[[` trigger passes 'page'. */
    readonly initialTab = input<WikiLinkPickerTab>('page');
    readonly pages = input<readonly WikiPageSummaryDto[]>([]);
    /** Page bodies, for the heading sub-rows. `WikiContentCacheService.content()` fits as-is. */
    readonly contentByPageId = input<ReadonlyMap<string, string>>(new Map());
    /** Seeds the search field. The `[[` trigger feeds its query through here. */
    readonly query = input('');
    /** Seeds the URL field, e.g. the href of the link the caret is already inside. */
    readonly href = input('');
    /** Where to hang the panel. A caret rect from `coordsAtPos`, or a button's rect. */
    readonly anchor = input<AnchorRect | null>(null);
    /** True when the picker owns the keyboard. False leaves focus in the editor, as `[[` needs. */
    readonly captureFocus = input(false);

    readonly applied = output<WikiLinkResult>();
    readonly removed = output<void>();
    readonly dismissed = output<void>();

    protected readonly tab = signal<WikiLinkPickerTab>('page');
    protected readonly activeIndex = signal(0);
    protected readonly queryText = signal('');
    protected readonly position = signal({top: 0, left: 0});
    protected readonly hrefText = signal('');

    protected readonly tabs: readonly {tab: WikiLinkPickerTab; labelKey: string}[] = [
        {tab: 'page', labelKey: 'WIKI.LINK_PICKER.TAB_PAGE'},
        {tab: 'url', labelKey: 'WIKI.LINK_PICKER.TAB_URL'},
    ];

    /** Stable so `aria-controls` on an external trigger can name it. */
    protected get listboxId(): string {
        return 'wiki-link-picker-list';
    }

    protected readonly rows = computed<PickerRow[]>(() => {
        const pages = this.pages();
        const query = this.queryText().trim();
        const byId = new Map(pages.map(page => [page.id, page]));
        // Same ranking as the palette and the [[ menu; an empty query lists pages instead of
        // answering nothing, so the picker is useful before anything is typed.
        const ordered = query
            ? searchWiki(
                  pages.map(page => ({id: page.id, title: page.title, tags: page.tags})),
                  query,
                  MAX_PAGES,
              )
                  .map(hit => byId.get(hit.id))
                  .filter((page): page is WikiPageSummaryDto => !!page)
            : [...pages].slice(0, MAX_PAGES);

        const content = this.contentByPageId();
        const rows: PickerRow[] = [];
        for (const page of ordered) {
            rows.push({
                id: `wiki-link-row-${page.id}`,
                kind: 'page',
                pageId: page.id,
                headingId: null,
                title: page.title,
                level: 0,
            });
            const headings = headingsFromMarkdown(content.get(page.id) ?? page.content ?? '');
            const lowered = query.toLowerCase();
            const matching = lowered
                ? headings.filter(heading => heading.text.toLowerCase().includes(lowered))
                : [];
            for (const heading of (matching.length ? matching : headings).slice(0, MAX_HEADINGS)) {
                rows.push({
                    id: `wiki-link-row-${page.id}-${heading.id}`,
                    kind: 'heading',
                    pageId: page.id,
                    headingId: heading.id,
                    title: heading.text,
                    level: heading.level,
                });
            }
        }
        return rows;
    });

    protected readonly activeOptionId = computed(() => this.rows()[this.activeIndex()]?.id ?? null);

    private readonly normalised = computed(() => normaliseExternalHref(this.hrefText()));
    protected readonly urlProblem = computed(
        () => this.hrefText().trim().length > 0 && this.normalised().status === 'blocked',
    );
    protected readonly urlPreview = computed(() =>
        this.normalised().status === 'scheme-added' ? this.normalised().href : '',
    );

    private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
    private readonly queryInput = viewChild<ElementRef<HTMLInputElement>>('queryInput');
    private readonly urlInput = viewChild<ElementRef<HTMLInputElement>>('urlInput');
    private readonly rowEls = viewChildren<ElementRef<HTMLElement>>('rowEl');

    private readonly floating = injectWikiFloating({
        reposition: () => this.reposition(),
        close: () => this.dismissed.emit(),
        contains: node => this.panel()?.nativeElement.contains(node) ?? false,
        // Escape reaches this component through handleKey while focus is in the editor.
        escape: false,
    });

    constructor() {
        effect(() => {
            if (this.open()) {
                this.tab.set(untracked(this.initialTab));
                this.hrefText.set(untracked(this.href));
                this.queryText.set(untracked(this.query));
                this.activeIndex.set(0);
                this.floating.attach();
            } else {
                this.floating.detach();
            }
        });

        // The `[[` trigger keeps typing into the document, so its query arrives as an input.
        effect(() => {
            const seeded = this.query();
            if (this.open() && !untracked(this.captureFocus)) this.queryText.set(seeded);
        });

        effect(() => {
            this.anchor();
            this.rows();
            if (this.open()) this.reposition();
        });

        effect(() => {
            const length = this.rows().length;
            if (untracked(this.activeIndex) >= length) this.activeIndex.set(0);
        });

        effect(() => {
            const index = this.activeIndex();
            if (this.open()) this.rowEls()[index]?.nativeElement.scrollIntoView({block: 'nearest'});
        });

        effect(() => {
            if (!this.open() || !this.captureFocus()) return;
            const field = this.tab() === 'page' ? this.queryInput() : this.urlInput();
            field?.nativeElement.focus();
        });
    }

    /**
     * Returns true when the key was consumed, so the editor does not also act on it. Tab is always
     * consumed while open: left to fall through it reaches the editor's tab guard and injects four
     * non-breaking spaces into whatever field has focus.
     */
    handleKey(event: KeyboardEvent): boolean {
        if (!this.open()) return false;
        const rows = this.rows();

        if (event.key === 'Escape') {
            this.dismissed.emit();
            return true;
        }
        if (event.key === 'Tab') {
            this.selectTab(this.tab() === 'page' ? 'url' : 'page');
            return true;
        }
        if (this.tab() === 'url') {
            if (event.key !== 'Enter') return false;
            // Nothing typed yet: Enter still has to be able to break the line.
            if (!this.hrefText().trim()) return false;
            this.applyUrl();
            return true;
        }
        if (event.key === 'ArrowDown') {
            this.activeIndex.update(i => (i + 1) % Math.max(1, rows.length));
            return true;
        }
        if (event.key === 'ArrowUp') {
            this.activeIndex.update(i => (i - 1 + rows.length) % Math.max(1, rows.length));
            return true;
        }
        if (event.key === 'Enter') {
            const row = rows[this.activeIndex()];
            // Not consumed with an empty list, so Enter still breaks the line under a `[[` run
            // that happens to match no page.
            if (!row) return false;
            this.chooseRow(row);
            return true;
        }
        return false;
    }

    reset(): void {
        this.activeIndex.set(0);
    }

    protected selectTab(tab: WikiLinkPickerTab): void {
        this.tab.set(tab);
        this.activeIndex.set(0);
    }

    protected onQuery(value: string): void {
        this.queryText.set(value);
    }

    protected chooseRow(row: PickerRow): void {
        this.applied.emit({
            kind: 'page',
            pageId: row.pageId,
            headingId: row.headingId,
            title: row.title,
        });
    }

    protected applyUrl(): void {
        const result = this.normalised();
        if (result.status === 'blocked') return;
        this.applied.emit({kind: 'url', href: result.href});
    }

    private reposition(): void {
        const anchor = this.anchor();
        if (!anchor) return;
        const element = this.panel()?.nativeElement;
        const size = element
            ? {width: element.offsetWidth || PANEL.width, height: element.offsetHeight || PANEL.height}
            : PANEL;
        this.position.set(anchorTo(anchor, size));
    }
}
