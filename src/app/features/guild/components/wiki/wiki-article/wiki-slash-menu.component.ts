import {Component, computed, input, output, signal} from '@angular/core';
import {Editor} from '@tiptap/core';

export interface SlashItem {
    label: string;
    icon: string;
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
    template: `
        @if (open()) {
            <div [style.left.px]="position().left" [style.top.px]="position().top"
                 class="fixed z-50 w-56 overflow-hidden rounded-xl border border-border bg-card
                        py-1 shadow-xl">
                @for (item of filtered(); track item.label; let i = $index) {
                    <button (click)="choose(item)"
                            [class.bg-hover]="i === activeIndex()"
                            class="flex w-full cursor-pointer items-center gap-2.5 border-0
                                   bg-transparent px-3 py-2 text-left text-[0.8125rem]
                                   text-white/75 hover:bg-hover">
                        <i [class]="item.icon" class="pi text-[0.75rem] text-white/40"></i>
                        {{ item.label }}
                    </button>
                }
                @if (filtered().length === 0) {
                    <p class="px-3 py-2 text-[0.75rem] text-white/30">No blocks match</p>
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
        {label: 'Heading 1', icon: 'pi-hashtag', keywords: 'h1 title heading', run: e => e.chain().focus().toggleHeading({level: 1}).run()},
        {label: 'Heading 2', icon: 'pi-hashtag', keywords: 'h2 heading subtitle', run: e => e.chain().focus().toggleHeading({level: 2}).run()},
        {label: 'Heading 3', icon: 'pi-hashtag', keywords: 'h3 heading', run: e => e.chain().focus().toggleHeading({level: 3}).run()},
        {label: 'Bullet list', icon: 'pi-list', keywords: 'bullet unordered list ul', run: e => e.chain().focus().toggleBulletList().run()},
        {label: 'Numbered list', icon: 'pi-sort-numeric-up-alt', keywords: 'numbered ordered list ol', run: e => e.chain().focus().toggleOrderedList().run()},
        {label: 'Task list', icon: 'pi-check-square', keywords: 'task todo checkbox', run: e => e.chain().focus().toggleTaskList().run()},
        {label: 'Quote', icon: 'pi-comment', keywords: 'quote blockquote', run: e => e.chain().focus().toggleBlockquote().run()},
        {label: 'Code block', icon: 'pi-code', keywords: 'code block pre', run: e => e.chain().focus().toggleCodeBlock().run()},
        {label: 'Divider', icon: 'pi-minus', keywords: 'divider rule hr separator', run: e => e.chain().focus().setHorizontalRule().run()},
        {label: 'Table', icon: 'pi-table', keywords: 'table grid', run: e => e.chain().focus().insertTable({rows: 3, cols: 3, withHeaderRow: true}).run()},
    ];

    protected readonly filtered = computed(() => {
        const q = this.query().toLowerCase();
        if (!q) return this.items;
        return this.items.filter(i => `${i.label} ${i.keywords}`.toLowerCase().includes(q));
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
