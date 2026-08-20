import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    ElementRef,
    inject,
    input,
    OnDestroy,
    output,
    signal,
    viewChild,
    viewChildren,
} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Editor} from '@tiptap/core';
import {KeybindsService} from '../../../../../services/keybinds.service';
import {formatAccelerator} from '../../../../../services/native-ptt.service';
import {WikiEditorKeybindId} from '../../../../../models/keybind-action.model';
import {
    isFormatActive,
    WIKI_FORMAT_ACTIONS,
    WIKI_INLINE_FORMAT_IDS,
    WikiFormatAction,
} from './wiki-format-actions';
import {
    SlashItem,
    WikiSlashMenuComponent,
    wikiTurnIntoItems,
    WIKI_SLASH_ITEMS,
} from './wiki-slash-menu.component';
import {anchorTo, AnchorRect} from './wiki-floating';

/** Which dropdown the bar has open. */
type ToolbarMenu = 'turn-into' | 'insert' | null;

const MENU_SIZE = {width: 320, height: 340};

/**
 * The formatting bar, shown only while editing.
 *
 * Nine controls, not twenty: the block half lives behind "Turn into" and `+`, both of which render
 * the slash menu's own list rather than a second copy of it. The whole bar is one tab stop, with a
 * roving tabindex inside it, so reaching the document by keyboard does not cost twenty presses.
 */
@Component({
    selector: 'app-wiki-toolbar',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule, WikiSlashMenuComponent],
    template: `
        <!-- mousedown swallowed for the whole bar: pressing a button otherwise blurs the editor and collapses the selection before the click handler runs (focusing in the chain restores the caret, not the range). -->
        <div
            #bar
            (keydown)="onKeydown($event)"
            (mousedown)="$event.preventDefault()"
            [attr.aria-label]="'WIKI.TOOLBAR.LABEL' | translate"
            class="relative flex shrink-0 items-center gap-0.5 border-b border-white/[0.08]
                    bg-sidebar/60 px-4 py-1.5"
            role="toolbar"
            tabindex="-1"
        >
            <button
                #stop
                (click)="openMenu('turn-into', $event)"
                [attr.aria-expanded]="menu() === 'turn-into'"
                [attr.tabindex]="tabIndexOf(0)"
                [disabled]="sourceMode()"
                [title]="'WIKI.TOOLBAR.TURN_INTO' | translate"
                class="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border-0
                           bg-transparent px-2 text-[0.75rem] text-text-secondary transition-colors
                           hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed
                           disabled:opacity-30 disabled:hover:bg-transparent"
                type="button"
            >
                <span class="max-w-[7rem] truncate">{{ currentBlockKey() | translate }}</span>
                <i class="pi pi-angle-down text-[0.5rem] opacity-60"></i>
            </button>

            <span class="mx-1 h-4 w-px shrink-0 bg-white/[0.10]"></span>

            @for (action of inlineActions; track action.id; let i = $index) {
                <button
                    #stop
                    (click)="apply(action)"
                    [attr.aria-pressed]="isActive(action)"
                    [attr.tabindex]="tabIndexOf(i + 1)"
                    [class.bg-hover]="isActive(action)"
                    [class.text-brand-dim]="isActive(action)"
                    [class]="action.className"
                    [disabled]="sourceMode()"
                    [title]="hint(action)"
                    class="flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-md
                               border-0 bg-transparent px-1.5 text-text-secondary transition-colors
                               hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed
                               disabled:opacity-30 disabled:hover:bg-transparent"
                    type="button"
                >
                    {{ action.label }}
                </button>
            }

            <span class="mx-1 h-4 w-px shrink-0 bg-white/[0.10]"></span>

            <button
                #stop
                (click)="requestLink($event)"
                [attr.aria-pressed]="isActive(linkAction)"
                [attr.tabindex]="tabIndexOf(6)"
                [class.bg-hover]="isActive(linkAction)"
                [class.text-brand-dim]="isActive(linkAction)"
                [disabled]="sourceMode()"
                [title]="hint(linkAction)"
                class="flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-md
                           border-0 bg-transparent px-1.5 text-text-secondary transition-colors
                           hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed
                           disabled:opacity-30 disabled:hover:bg-transparent"
                type="button"
            >
                <i class="pi pi-link text-[0.75rem]"></i>
            </button>

            <button
                #stop
                (click)="openMenu('insert', $event)"
                [attr.aria-expanded]="menu() === 'insert'"
                [attr.tabindex]="tabIndexOf(7)"
                [disabled]="sourceMode()"
                [title]="'WIKI.TOOLBAR.INSERT' | translate"
                class="flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-md
                           border-0 bg-transparent px-1.5 text-text-secondary transition-colors
                           hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed
                           disabled:opacity-30 disabled:hover:bg-transparent"
                type="button"
            >
                <i class="pi pi-plus text-[0.75rem]"></i>
            </button>

            <span class="mx-1 h-4 w-px shrink-0 bg-white/[0.10]"></span>

            <button
                #stop
                (click)="undo()"
                [attr.tabindex]="tabIndexOf(8)"
                [disabled]="sourceMode()"
                [title]="'WIKI.TOOLBAR.UNDO' | translate"
                class="flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-md
                           border-0 bg-transparent px-1.5 text-text-secondary transition-colors
                           hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed
                           disabled:opacity-30 disabled:hover:bg-transparent"
                type="button"
            >
                <i class="pi pi-undo text-[0.75rem]"></i>
            </button>
            <button
                #stop
                (click)="redo()"
                [attr.tabindex]="tabIndexOf(9)"
                [disabled]="sourceMode()"
                [title]="'WIKI.TOOLBAR.REDO' | translate"
                class="flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-md
                           border-0 bg-transparent px-1.5 text-text-secondary transition-colors
                           hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed
                           disabled:opacity-30 disabled:hover:bg-transparent"
                type="button"
            >
                <i class="pi pi-refresh text-[0.75rem]"></i>
            </button>

            <span class="flex-1"></span>

            <!-- Escape hatch for anyone who would rather write the markup than click at it; the shortcut is printed on the button rather than left to the tooltip, since a shortcut nobody is told about is a shortcut nobody uses. -->
            <button
                #stop
                (click)="toggleSource.emit()"
                [attr.aria-pressed]="sourceMode()"
                [attr.tabindex]="tabIndexOf(10)"
                [class.bg-hover]="sourceMode()"
                [class.text-brand-dim]="sourceMode()"
                [title]="(sourceMode() ? 'WIKI.TOOLBAR.SOURCE_OFF' : 'WIKI.TOOLBAR.SOURCE_ON') | translate"
                class="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border-0
                           bg-transparent px-2 text-[0.6875rem] font-medium text-text-secondary
                           transition-colors hover:bg-hover hover:text-text-primary"
                type="button"
            >
                <i class="pi pi-code text-[0.75rem]"></i>
                {{ 'WIKI.TOOLBAR.MARKDOWN' | translate }}
                @if (markdownShortcut(); as keys) {
                    <span
                        class="rounded border border-white/[0.12] bg-white/[0.04] px-1
                                 py-px font-mono text-[0.5625rem] tracking-wide text-text-muted"
                    >
                        {{ keys }}
                    </span>
                }
            </button>
        </div>

        <app-wiki-slash-menu
            #dropdown
            (selected)="choose($event)"
            [editor]="editor()"
            [items]="menu() === 'turn-into' ? turnIntoItems : insertItems"
            [open]="menu() !== null"
            [position]="menuPosition()"
            query=""
        />
    `,
})
export class WikiToolbarComponent implements OnDestroy {
    readonly editor = input<Editor | undefined>(undefined);
    /** Every rich-text action is inert against a raw textarea, so they grey out instead. */
    readonly sourceMode = input(false);

    readonly toggleSource = output<void>();
    /** A block the article has to apply, because the slash menu's host and AI rows need its state. */
    readonly insertItem = output<SlashItem>();
    /** The link picker replaces the raw href field this bar used to open. */
    readonly openLinkPicker = output<{href: string; anchor: DOMRect}>();

    protected readonly menu = signal<ToolbarMenu>(null);
    protected readonly menuPosition = signal({top: 0, left: 0});
    protected readonly focusIndex = signal(0);

    /** The key currently bound to the markdown toggle, as printed on the button; computed off the bindings signal so rebinding it in Settings updates the hint rather than leaving it advertising a key that no longer does anything. */
    protected readonly markdownShortcut = computed(() => this.chip('wiki-toggle-markdown'));

    /** Bumped from the editor's transaction stream, so the pressed states track the caret under OnPush. */
    private readonly version = signal(0);

    protected readonly currentBlockKey = computed(() => {
        this.version();
        const editor = this.editor();
        if (!editor || this.sourceMode()) return 'WIKI.BLOCK.TEXT';
        const match = this.turnIntoItems.find(
            item =>
                item.active &&
                item.active.name !== 'paragraph' &&
                editor.isActive(item.active.name, item.active.attrs),
        );
        return match?.labelKey ?? 'WIKI.BLOCK.TEXT';
    });

    private readonly keybinds = inject(KeybindsService);
    private readonly translate = inject(TranslateService);
    private readonly bar = viewChild<ElementRef<HTMLElement>>('bar');
    private readonly stops = viewChildren<ElementRef<HTMLButtonElement>>('stop');
    private readonly dropdown = viewChild<WikiSlashMenuComponent>('dropdown');

    /** Cached rather than filtered per read: a fresh array per change detection would re-run the menu's own computeds. */
    private turnIntoCache?: readonly SlashItem[];
    private watching?: Editor;
    private readonly onTransaction = () => this.version.update(v => v + 1);

    constructor() {
        effect(() => {
            const editor = this.editor();
            if (editor === this.watching) return;
            this.watching?.off('transaction', this.onTransaction);
            this.watching = editor;
            editor?.on('transaction', this.onTransaction);
            this.version.update(v => v + 1);
        });
    }

    ngOnDestroy(): void {
        this.watching?.off('transaction', this.onTransaction);
    }

    /** Public so the configurable Link shortcut opens the same picker the button does. */
    openLinkRow(): void {
        const anchor = this.stops()[6]?.nativeElement.getBoundingClientRect();
        this.emitLink(anchor);
    }

    /** Public so the article can shut a dropdown when the editor takes over. */
    closeMenu(): void {
        this.menu.set(null);
    }

    protected get inlineActions(): WikiFormatAction[] {
        return WIKI_INLINE_FORMAT_IDS.map(id => WIKI_FORMAT_ACTIONS[id]);
    }

    protected get linkAction(): WikiFormatAction {
        return WIKI_FORMAT_ACTIONS['wiki-link'];
    }

    protected get insertItems(): readonly SlashItem[] {
        return WIKI_SLASH_ITEMS;
    }

    protected get turnIntoItems(): readonly SlashItem[] {
        return (this.turnIntoCache ??= wikiTurnIntoItems());
    }

    protected isActive(action: WikiFormatAction): boolean {
        this.version();
        if (this.sourceMode()) return false;
        return isFormatActive(action, this.editor());
    }

    /** The title carries the shortcut, so the bar advertises the faster path rather than hiding it. */
    protected hint(action: WikiFormatAction): string {
        const label = this.translate.instant(action.titleKey) as string;
        const keys = this.chip(action.id);
        return keys ? `${label} (${keys})` : label;
    }

    protected tabIndexOf(index: number): number {
        return index === this.focusIndex() ? 0 : -1;
    }

    protected apply(action: WikiFormatAction): void {
        const editor = this.editor();
        if (editor) action.run?.(editor);
    }

    protected undo(): void {
        this.editor()?.chain().focus().undo().run();
    }

    protected redo(): void {
        this.editor()?.chain().focus().redo().run();
    }

    protected requestLink(event: MouseEvent): void {
        this.emitLink((event.currentTarget as HTMLElement).getBoundingClientRect());
    }

    protected openMenu(which: Exclude<ToolbarMenu, null>, event: MouseEvent): void {
        if (this.menu() === which) {
            this.menu.set(null);
            return;
        }
        this.place((event.currentTarget as HTMLElement).getBoundingClientRect());
        this.dropdown()?.reset();
        this.menu.set(which);
    }

    protected choose(item: SlashItem): void {
        this.menu.set(null);
        this.insertItem.emit(item);
    }

    /** Arrow keys move within the bar, so the whole bar stays one tab stop. */
    protected onKeydown(event: KeyboardEvent): void {
        if (this.menu() !== null) {
            if (event.key === 'Escape') {
                event.preventDefault();
                this.menu.set(null);
                return;
            }
            if (this.dropdown()?.handleKey(event.key)) {
                event.preventDefault();
                return;
            }
        }
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const buttons = this.stops().map(ref => ref.nativeElement);
        if (!buttons.length) return;
        const next = (this.focusIndex() + step + buttons.length) % buttons.length;
        this.focusIndex.set(next);
        buttons[next].focus();
    }

    private emitLink(anchor: DOMRect | undefined): void {
        const editor = this.editor();
        if (!editor) return;
        const href = (editor.getAttributes('link')['href'] as string | undefined) ?? '';
        const rect = anchor ?? this.bar()?.nativeElement.getBoundingClientRect();
        if (rect) this.openLinkPicker.emit({href, anchor: rect});
    }

    private place(rect: AnchorRect): void {
        this.menuPosition.set(anchorTo(rect, MENU_SIZE));
    }

    private chip(id: WikiEditorKeybindId): string {
        const token = this.keybinds.getBinding(id);
        return token ? formatAccelerator(token).replace(/ \+ /g, '+') : '';
    }
}
