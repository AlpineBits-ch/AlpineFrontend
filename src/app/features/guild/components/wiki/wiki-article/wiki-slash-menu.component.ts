import {Component, computed, inject, input, output, signal} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Editor} from '@tiptap/core';

export interface SlashItem {
    /** A translation key. The filter matches the rendered label, not this. */
    labelKey: string;
    icon: string;
    /**
     * English search terms, kept untranslated on purpose: they are aliases people type from
     * habit ("ul", "hr", "todo"), not prose, and the translated label is matched alongside them.
     */
    keywords: string;
    run: (editor: Editor) => void;
}

/**
 * Block insertion, opened by typing `/` on an empty line.
 *
 * Replaces the block half of the old toolbar. A filtered list you type into scales past what a
 * row of icons can hold, and it costs nothing while you are not using it.
 */
@Component({
    selector: 'app-wiki-slash-menu',
    imports: [TranslateModule],
    template: `
        @if (open()) {
            <div [style.left.px]="position().left" [style.top.px]="position().top"
                 class="fixed z-50 w-56 overflow-hidden rounded-xl border border-border bg-card
                        py-1 shadow-xl">
                @for (item of filtered(); track item.labelKey; let i = $index) {
                    <button (click)="choose(item)"
                            [class.bg-hover]="i === activeIndex()"
                            class="flex w-full cursor-pointer items-center gap-2.5 border-0
                                   bg-transparent px-3 py-2 text-left text-[0.8125rem]
                                   text-white/75 hover:bg-hover">
                        <i [class]="item.icon" class="pi text-[0.75rem] text-white/40"></i>
                        {{ item.labelKey | translate }}
                    </button>
                }
                @if (filtered().length === 0) {
                    <p class="px-3 py-2 text-[0.75rem] text-white/30">
                        {{ 'WIKI.SLASH_MENU.NO_MATCH' | translate }}
                    </p>
                }
            </div>
        }
    `,
})
export class WikiSlashMenuComponent {
    readonly editor = input<Editor | undefined>(undefined);
    readonly query = input('');
    readonly open = input(false);
    readonly position = input<{ top: number; left: number }>({top: 0, left: 0});

    readonly selected = output<SlashItem>();

    protected readonly activeIndex = signal(0);

    protected readonly items: SlashItem[] = [
        {labelKey: 'WIKI.BLOCK.HEADING_1', icon: 'pi-hashtag', keywords: 'h1 title heading', run: e => e.chain().focus().toggleHeading({level: 1}).run()},
        {labelKey: 'WIKI.BLOCK.HEADING_2', icon: 'pi-hashtag', keywords: 'h2 heading subtitle', run: e => e.chain().focus().toggleHeading({level: 2}).run()},
        {labelKey: 'WIKI.BLOCK.HEADING_3', icon: 'pi-hashtag', keywords: 'h3 heading', run: e => e.chain().focus().toggleHeading({level: 3}).run()},
        {labelKey: 'WIKI.BLOCK.BULLET_LIST', icon: 'pi-list', keywords: 'bullet unordered list ul', run: e => e.chain().focus().toggleBulletList().run()},
        {labelKey: 'WIKI.BLOCK.NUMBERED_LIST', icon: 'pi-sort-numeric-up-alt', keywords: 'numbered ordered list ol', run: e => e.chain().focus().toggleOrderedList().run()},
        {labelKey: 'WIKI.BLOCK.TASK_LIST', icon: 'pi-check-square', keywords: 'task todo checkbox', run: e => e.chain().focus().toggleTaskList().run()},
        {labelKey: 'WIKI.BLOCK.QUOTE', icon: 'pi-comment', keywords: 'quote blockquote', run: e => e.chain().focus().toggleBlockquote().run()},
        {labelKey: 'WIKI.BLOCK.CODE_BLOCK', icon: 'pi-code', keywords: 'code block pre', run: e => e.chain().focus().toggleCodeBlock().run()},
        {labelKey: 'WIKI.BLOCK.DIVIDER', icon: 'pi-minus', keywords: 'divider rule hr separator', run: e => e.chain().focus().setHorizontalRule().run()},
        {labelKey: 'WIKI.BLOCK.TABLE', icon: 'pi-table', keywords: 'table grid', run: e => e.chain().focus().insertTable({rows: 3, cols: 3, withHeaderRow: true}).run()},
    ];

    private readonly translate = inject(TranslateService);

    protected readonly filtered = computed(() => {
        const q = this.query().toLowerCase();
        if (!q) return this.items;
        // Matched against the translated label as well as the English aliases: a German user
        // typing "Tabelle" and one typing "table" both have to find the table item.
        return this.items.filter(i => {
            const label = this.translate.instant(i.labelKey) as string;
            return `${label} ${i.keywords}`.toLowerCase().includes(q);
        });
    });

    /** Returns true when the key was consumed, so the editor does not also act on it. */
    handleKey(key: string): boolean {
        if (!this.open()) return false;
        const items = this.filtered();
        if (key === 'ArrowDown') {
            this.activeIndex.update(i => (i + 1) % Math.max(1, items.length));
            return true;
        }
        if (key === 'ArrowUp') {
            this.activeIndex.update(i => (i - 1 + items.length) % Math.max(1, items.length));
            return true;
        }
        if (key === 'Enter') {
            const item = items[this.activeIndex()];
            if (item) this.choose(item);
            return true;
        }
        return false;
    }

    reset(): void {
        this.activeIndex.set(0);
    }

    protected choose(item: SlashItem): void {
        this.selected.emit(item);
    }
}
