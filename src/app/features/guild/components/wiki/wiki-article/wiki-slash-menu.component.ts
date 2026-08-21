import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    ElementRef,
    inject,
    input,
    output,
    signal,
    untracked,
    viewChildren,
} from '@angular/core';
import {NgClass} from '@angular/common';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Editor} from '@tiptap/core';
// Side-effect imports: toggleCodeBlock, setCallout and setToggle reach ChainedCommands through
// module augmentation, so a compilation whose import graph does not otherwise reach the
// extensions that declare them (this component's own spec, for one) does not know they exist.
import '@tiptap/starter-kit';
import '@tiptap/extension-table';
import './blocks/wiki-callout';
import './blocks/wiki-toggle';
import {AiTransformOp} from '../../../../../services/ai-provider';

/** The section an item is filed under. Order here is the order they render in. */
export type SlashGroup = 'basic' | 'lists' | 'media' | 'advanced' | 'ai';

/** Something the menu cannot do with an editor chain alone, because the state it needs lives on the article: the hidden file input, and the [[ trigger that has to survive the menu closing. */
export type SlashHostAction = 'image' | 'page-link';

export interface SlashItem {
    /** A translation key. The filter matches the rendered label, not this. */
    labelKey: string;
    /** One line under the label; not filtered on, since descriptions match far too loosely. */
    descriptionKey: string;
    icon: string;
    group: SlashGroup;
    /** English search terms, kept untranslated: they are aliases people type from habit ("ul", "hr", "todo"), not prose, and the translated label is matched alongside them. */
    keywords: string;
    /** The whole command, for items the editor can do by itself; absent on AI and host items, which carry a discriminator below instead and are dispatched by the article, the only place that holds the AI service, the page body and the file input. */
    run?: (editor: Editor) => void;
    /** Rewrites the current body. Mutually exclusive with `run`. */
    aiOp?: AiTransformOp;
    /** Generates new content from something the user still has to describe. */
    aiGenerate?: 'draft' | 'table';
    /** Needs the article's own state rather than the editor's. */
    hostAction?: SlashHostAction;
    /** Node name and attributes that mean this block is already what the caret is in. */
    active?: {name: string; attrs?: Record<string, unknown>};
}

const GROUP_LABELS: Record<SlashGroup, string> = {
    basic: 'WIKI.SLASH_MENU.GROUP_BASIC',
    lists: 'WIKI.SLASH_MENU.GROUP_LISTS',
    media: 'WIKI.SLASH_MENU.GROUP_MEDIA',
    advanced: 'WIKI.SLASH_MENU.GROUP_ADVANCED',
    ai: 'WIKI.SLASH_MENU.GROUP_AI',
};

const GROUP_ORDER: readonly SlashGroup[] = ['basic', 'lists', 'media', 'advanced', 'ai'];

/**
 * Declared in group order, which is also the order they are keyboard-traversed in: the flat
 * filtered list is what the arrow keys index, and the grouping is a view over it.
 *
 * Exported because the toolbar's insert menu, its "Turn into" dropdown and the block handle's
 * submenu all offer the same blocks; a second copy would drift the moment a block is added.
 */
export const WIKI_SLASH_ITEMS: readonly SlashItem[] = [
    {
        group: 'basic',
        labelKey: 'WIKI.BLOCK.TEXT',
        descriptionKey: 'WIKI.BLOCK.TEXT_DESC',
        icon: 'pi-align-left',
        keywords: 'text paragraph plain body p',
        active: {name: 'paragraph'},
        run: e => e.chain().focus().setParagraph().run(),
    },
    {
        group: 'basic',
        labelKey: 'WIKI.BLOCK.HEADING_1',
        descriptionKey: 'WIKI.BLOCK.HEADING_1_DESC',
        icon: 'pi-hashtag',
        keywords: 'h1 title heading',
        active: {name: 'heading', attrs: {level: 1}},
        run: e => e.chain().focus().toggleHeading({level: 1}).run(),
    },
    {
        group: 'basic',
        labelKey: 'WIKI.BLOCK.HEADING_2',
        descriptionKey: 'WIKI.BLOCK.HEADING_2_DESC',
        icon: 'pi-hashtag',
        keywords: 'h2 heading subtitle section',
        active: {name: 'heading', attrs: {level: 2}},
        run: e => e.chain().focus().toggleHeading({level: 2}).run(),
    },
    {
        group: 'basic',
        labelKey: 'WIKI.BLOCK.HEADING_3',
        descriptionKey: 'WIKI.BLOCK.HEADING_3_DESC',
        icon: 'pi-hashtag',
        keywords: 'h3 heading subsection',
        active: {name: 'heading', attrs: {level: 3}},
        run: e => e.chain().focus().toggleHeading({level: 3}).run(),
    },
    {
        group: 'basic',
        labelKey: 'WIKI.BLOCK.QUOTE',
        descriptionKey: 'WIKI.BLOCK.QUOTE_DESC',
        icon: 'pi-comment',
        keywords: 'quote blockquote callout cite',
        active: {name: 'blockquote'},
        run: e => e.chain().focus().toggleBlockquote().run(),
    },
    {
        group: 'basic',
        labelKey: 'WIKI.BLOCK.DIVIDER',
        descriptionKey: 'WIKI.BLOCK.DIVIDER_DESC',
        icon: 'pi-minus',
        keywords: 'divider rule hr separator line',
        run: e => e.chain().focus().setHorizontalRule().run(),
    },

    {
        group: 'lists',
        labelKey: 'WIKI.BLOCK.BULLET_LIST',
        descriptionKey: 'WIKI.BLOCK.BULLET_LIST_DESC',
        icon: 'pi-list',
        keywords: 'bullet unordered list ul',
        active: {name: 'bulletList'},
        run: e => e.chain().focus().toggleBulletList().run(),
    },
    {
        group: 'lists',
        labelKey: 'WIKI.BLOCK.NUMBERED_LIST',
        descriptionKey: 'WIKI.BLOCK.NUMBERED_LIST_DESC',
        icon: 'pi-sort-numeric-up-alt',
        keywords: 'numbered ordered list ol',
        active: {name: 'orderedList'},
        run: e => e.chain().focus().toggleOrderedList().run(),
    },
    {
        group: 'lists',
        labelKey: 'WIKI.BLOCK.TASK_LIST',
        descriptionKey: 'WIKI.BLOCK.TASK_LIST_DESC',
        icon: 'pi-check-square',
        keywords: 'task todo checkbox checklist',
        active: {name: 'taskList'},
        run: e => e.chain().focus().toggleTaskList().run(),
    },

    {
        group: 'media',
        labelKey: 'WIKI.BLOCK.IMAGE',
        descriptionKey: 'WIKI.BLOCK.IMAGE_DESC',
        icon: 'pi-image',
        keywords: 'image picture photo upload file screenshot',
        hostAction: 'image',
    },
    {
        group: 'media',
        labelKey: 'WIKI.BLOCK.TABLE',
        descriptionKey: 'WIKI.BLOCK.TABLE_DESC',
        icon: 'pi-table',
        keywords: 'table grid rows columns',
        run: e => e.chain().focus().insertTable({rows: 3, cols: 3, withHeaderRow: true}).run(),
    },

    {
        group: 'advanced',
        labelKey: 'WIKI.BLOCK.CODE_BLOCK',
        descriptionKey: 'WIKI.BLOCK.CODE_BLOCK_DESC',
        icon: 'pi-code',
        keywords: 'code block pre snippet',
        active: {name: 'codeBlock'},
        run: e => e.chain().focus().toggleCodeBlock().run(),
    },
    {
        group: 'advanced',
        labelKey: 'WIKI.BLOCK.CALLOUT',
        descriptionKey: 'WIKI.BLOCK.CALLOUT_DESC',
        icon: 'pi-info-circle',
        keywords: 'callout note info tip warning danger admonition alert',
        active: {name: 'callout'},
        run: e => e.chain().focus().setCallout({variant: 'info'}).run(),
    },
    {
        group: 'advanced',
        labelKey: 'WIKI.BLOCK.TOGGLE',
        descriptionKey: 'WIKI.BLOCK.TOGGLE_DESC',
        icon: 'pi-chevron-right',
        keywords: 'toggle details collapse accordion expand',
        active: {name: 'toggle'},
        run: e => e.chain().focus().setToggle().run(),
    },
    {
        group: 'advanced',
        labelKey: 'WIKI.BLOCK.DIAGRAM',
        descriptionKey: 'WIKI.BLOCK.DIAGRAM_DESC',
        icon: 'pi-sitemap',
        keywords: 'diagram mermaid flowchart graph sequence',
        active: {name: 'codeBlock', attrs: {language: 'mermaid'}},
        run: e => e.chain().focus().toggleCodeBlock({language: 'mermaid'}).run(),
    },
    {
        group: 'advanced',
        labelKey: 'WIKI.BLOCK.PAGE_LINK',
        descriptionKey: 'WIKI.BLOCK.PAGE_LINK_DESC',
        icon: 'pi-link',
        keywords: 'link page wiki reference mention',
        hostAction: 'page-link',
    },

    {
        group: 'ai',
        labelKey: 'WIKI.SLASH_MENU.AI_WRITE',
        descriptionKey: 'WIKI.SLASH_MENU.AI_WRITE_DESC',
        icon: 'pi-sparkles',
        keywords: 'ai write generate draft prompt ask',
        aiGenerate: 'draft',
    },
    {
        group: 'ai',
        labelKey: 'WIKI.SLASH_MENU.AI_CONTINUE',
        descriptionKey: 'WIKI.SLASH_MENU.AI_CONTINUE_DESC',
        icon: 'pi-angle-double-right',
        keywords: 'ai continue keep writing more',
        aiOp: 'continue',
    },
    {
        group: 'ai',
        labelKey: 'WIKI.SLASH_MENU.AI_SUMMARIZE',
        descriptionKey: 'WIKI.SLASH_MENU.AI_SUMMARIZE_DESC',
        icon: 'pi-align-center',
        keywords: 'ai summarize summary tldr shorten',
        aiOp: 'summarize',
    },
    {
        group: 'ai',
        labelKey: 'WIKI.SLASH_MENU.AI_EXPAND',
        descriptionKey: 'WIKI.SLASH_MENU.AI_EXPAND_DESC',
        icon: 'pi-arrows-h',
        keywords: 'ai expand longer elaborate detail',
        aiOp: 'expand',
    },
    {
        group: 'ai',
        labelKey: 'WIKI.SLASH_MENU.AI_IMPROVE',
        descriptionKey: 'WIKI.SLASH_MENU.AI_IMPROVE_DESC',
        icon: 'pi-star',
        keywords: 'ai improve rewrite polish better',
        aiOp: 'improve',
    },
    {
        group: 'ai',
        labelKey: 'WIKI.SLASH_MENU.AI_TABLE',
        descriptionKey: 'WIKI.SLASH_MENU.AI_TABLE_DESC',
        icon: 'pi-table',
        keywords: 'ai table-from table from description generate',
        aiGenerate: 'table',
    },
];

/** The rows a block can be turned into: everything the editor can apply by itself. */
export function wikiTurnIntoItems(): readonly SlashItem[] {
    return WIKI_SLASH_ITEMS.filter(item => !!item.run);
}

/** Block insertion, opened by typing /; replaces the block half of the old toolbar, since a filtered list scales past what a row of icons can hold and costs nothing while unused. Grouped with a description per row rather than a bare icon list, since scanning is the slow part and "Expand" is not self-evident the way "Quote" is. */
@Component({
    selector: 'app-wiki-slash-menu',
    imports: [NgClass, TranslateModule],
    template: `
        @if (open()) {
            <div
                [style.left.px]="position().left"
                [style.top.px]="position().top"
                class="fixed z-50 flex w-80 flex-col overflow-hidden rounded-xl border
                        border-border bg-card shadow-xl"
            >
                <div class="thin-scrollbar max-h-80 overflow-y-auto py-1">
                    @for (group of groups(); track group.key) {
                        <p
                            class="px-3 pb-1 pt-2 text-[0.625rem] font-semibold uppercase
                                  tracking-wider text-text-muted"
                        >
                            {{ group.labelKey | translate }}
                        </p>
                        @for (entry of group.entries; track entry.item.labelKey) {
                            <!-- The keyboard selection must not be styled as mouse hover; the hover colour sits only two percent off the card behind it, so arrowing through the menu would look like nothing happened. -->
                            <button
                                #itemEl
                                (click)="choose(entry.item)"
                                [ngClass]="
                                    entry.index === activeIndex()
                                        ? 'bg-brand/25 ring-1 ring-inset ring-brand/40'
                                        : 'hover:bg-hover'
                                "
                                class="flex w-full cursor-pointer items-center gap-2.5 border-0
                                           bg-transparent px-3 py-1.5 text-left"
                            >
                                <span
                                    class="flex h-7 w-7 shrink-0 items-center justify-center
                                             rounded-md border border-border-subtle bg-hover"
                                >
                                    <!-- Colour folded into the one binding: two competing text-* utilities on the same element resolve by stylesheet order, which Tailwind decides, not by which is written last here. -->
                                    <i [class]="iconClass(entry.item)" class="pi text-[0.75rem]"></i>
                                </span>
                                <span class="min-w-0 flex-1">
                                    <span class="block truncate text-[0.8125rem] text-text-primary">
                                        {{ entry.item.labelKey | translate }}
                                    </span>
                                    <span class="block truncate text-[0.6875rem] text-text-muted">
                                        {{ entry.item.descriptionKey | translate }}
                                    </span>
                                </span>
                            </button>
                        }
                    }
                    @if (filtered().length === 0) {
                        <p class="px-3 py-2 text-[0.75rem] text-text-muted">
                            {{ 'WIKI.SLASH_MENU.NO_MATCH' | translate }}
                        </p>
                    }
                </div>
                <div class="border-t border-border-subtle px-3 py-1.5 text-[0.625rem] text-text-muted">
                    {{ 'WIKI.SLASH_MENU.HINT' | translate }}
                </div>
            </div>
        }
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WikiSlashMenuComponent {
    readonly editor = input<Editor | undefined>(undefined);
    readonly query = input('');
    readonly open = input(false);
    readonly position = input<{top: number; left: number}>({top: 0, left: 0});

    /** The rows to offer. The toolbar's "Turn into" dropdown passes the block subset. */
    readonly items = input<readonly SlashItem[]>(WIKI_SLASH_ITEMS);

    readonly selected = output<SlashItem>();

    protected readonly activeIndex = signal(0);

    private readonly translate = inject(TranslateService);
    private readonly itemEls = viewChildren<ElementRef<HTMLElement>>('itemEl');

    protected readonly filtered = computed(() => {
        const q = this.query().toLowerCase();
        if (!q) return this.items();
        // Matched against the translated label as well as the English aliases: a German user typing "Tabelle" and one typing "table" both have to find the table item.
        return this.items().filter(i => {
            const label = this.translate.instant(i.labelKey) as string;
            return `${label} ${i.keywords}`.toLowerCase().includes(q);
        });
    });

    /** The rendered shape: sections in declaration order, each row carrying its index in the flat list so the highlight and the arrow keys agree without a second lookup. */
    protected readonly groups = computed(() => {
        const filtered = this.filtered();
        return GROUP_ORDER.map(key => ({
            key,
            labelKey: GROUP_LABELS[key],
            entries: filtered.map((item, index) => ({item, index})).filter(entry => entry.item.group === key),
        })).filter(group => group.entries.length > 0);
    });

    constructor() {
        // Typing another character can shorten the list out from under the highlight, and Enter on an index that no longer exists silently does nothing.
        effect(() => {
            const length = this.filtered().length;
            if (untracked(this.activeIndex) >= length) this.activeIndex.set(0);
        });

        // The list is taller than its box once every group is showing, so arrowing past the fold has to bring the highlight with it or the selection disappears off-screen.
        effect(() => {
            const index = this.activeIndex();
            if (!this.open()) return;
            this.itemEls()[index]?.nativeElement.scrollIntoView({block: 'nearest'});
        });
    }

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
        if (key === 'Enter' || key === 'Tab') {
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

    /** The AI rows get the accent so the group reads as one thing at a glance. */
    protected iconClass(item: SlashItem): string {
        return `${item.icon} ${item.group === 'ai' ? 'text-brand-dim' : 'text-text-secondary'}`;
    }
}
