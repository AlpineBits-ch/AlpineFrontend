import {Component, computed, inject, input, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Editor} from '@tiptap/core';
import {Tooltip} from 'primeng/tooltip';
import {TranslateModule} from '@ngx-translate/core';
import {KeybindsService} from '../../../../../services/keybinds.service';
import {formatAccelerator} from '../../../../../services/native-ptt.service';

interface ToolbarAction {
    /** Text glyph. PrimeIcons has no bold/italic/underline/strike, and letters read better anyway. */
    label?: string;
    icon?: string;
    titleKey: string;
    /** Mark or node name for the active check. Omitted for one-shot inserts. */
    active?: string;
    attrs?: Record<string, unknown>;
    className?: string;
    run: (editor: Editor) => void;
}

/** The formatting bar, shown only while editing: the bubble menu (needs a selection) and the slash menu (needs typing /) are good once known but invisible until then, so this bar is the discoverable surface that advertises what a page can hold; the two menus remain the faster path once learned. Absent in read mode, which is what "no chrome while reading" means. */
@Component({
    selector: 'app-wiki-toolbar',
    imports: [Tooltip, FormsModule, TranslateModule],
    template: `
        <!-- mousedown swallowed for the whole bar: pressing a button otherwise blurs the editor and collapses the selection before the click handler runs (focusing in the chain restores the caret, not the range). The link row is excluded below, since its input must be able to take focus. -->
        <div (mousedown)="$event.preventDefault()"
             class="relative flex shrink-0 flex-wrap items-center gap-0.5 border-b
                    border-white/[0.08] bg-sidebar/60 px-4 py-1.5">
            @for (group of groups; track $index) {
                @if (!$first) {
                    <span class="mx-1 h-4 w-px shrink-0 bg-white/[0.10]"></span>
                }
                @for (action of group; track action.titleKey) {
                    <button (click)="run(action)"
                            [class.bg-hover]="isActive(action)"
                            [class.text-brand-dim]="isActive(action)"
                            [class]="action.className"
                            [disabled]="sourceMode()"
                            [pTooltip]="action.titleKey | translate"
                            class="flex h-7 min-w-7 cursor-pointer items-center justify-center
                                   rounded-md border-0 bg-transparent px-1.5 text-white/50
                                   transition-colors hover:bg-hover hover:text-white/90
                                   disabled:cursor-not-allowed disabled:opacity-30
                                   disabled:hover:bg-transparent"
                            tooltipPosition="bottom" type="button">
                        @if (action.icon) {
                            <i [class]="action.icon" class="pi text-[0.75rem]"></i>
                        } @else {
                            {{ action.label }}
                        }
                    </button>
                }
            }

            <span class="flex-1"></span>

            <!-- Escape hatch for anyone who would rather write the markup than click at it; the shortcut is printed on the button rather than left to the tooltip, since a shortcut nobody is told about is a shortcut nobody uses. -->
            <button (click)="toggleSource.emit()"
                    [class.bg-hover]="sourceMode()"
                    [class.text-brand-dim]="sourceMode()"
                    [pTooltip]="(sourceMode() ? 'WIKI.TOOLBAR.SOURCE_OFF' : 'WIKI.TOOLBAR.SOURCE_ON')
                                    | translate"
                    class="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border-0
                           bg-transparent px-2 text-[0.6875rem] font-medium text-white/50
                           transition-colors hover:bg-hover hover:text-white/90"
                    tooltipPosition="bottom" type="button">
                <i class="pi pi-code text-[0.75rem]"></i>
                {{ 'WIKI.TOOLBAR.MARKDOWN' | translate }}
                @if (markdownShortcut(); as keys) {
                    <span class="rounded border border-white/[0.12] bg-white/[0.04] px-1
                                 py-px font-mono text-[0.5625rem] tracking-wide text-white/35">
                        {{ keys }}
                    </span>
                }
            </button>

            <!-- Link entry: an inline row, not a modal, since a dialog moves focus far enough that the selection stops being obvious, and window.prompt is not answered at all by the WebView2 runtime this ships on. -->
            @if (linkOpen()) {
                <div (mousedown)="$event.stopPropagation()"
                     class="absolute left-4 top-full z-40 mt-1 flex items-center gap-1 rounded-lg
                            border border-border bg-card px-2 py-1.5 shadow-xl">
                    <input #linkInput (keydown.enter)="commitLink()" (keydown.escape)="closeLink()"
                           [(ngModel)]="linkHref"
                           class="w-64 border-0 bg-transparent text-[0.8125rem] text-white/80
                                  outline-none placeholder-white/25"
                           placeholder="https://example.com"/>
                    <button (click)="commitLink()"
                            class="cursor-pointer rounded border-0 bg-brand/20 px-2 py-1
                                   text-[0.6875rem] font-medium text-brand-dim hover:bg-brand/30"
                            type="button">{{ 'WIKI.TOOLBAR.LINK_APPLY' | translate }}
                    </button>
                    <button (click)="removeLink()"
                            class="cursor-pointer border-0 bg-transparent px-1 text-[0.6875rem]
                                   text-white/40 hover:text-white/70"
                            type="button">{{ 'WIKI.TOOLBAR.LINK_REMOVE' | translate }}
                    </button>
                </div>
            }
        </div>
    `,
})
export class WikiToolbarComponent {
    readonly editor = input<Editor | undefined>(undefined);
    /** Every rich-text action is inert against a raw textarea, so they grey out instead. */
    readonly sourceMode = input(false);

    readonly toggleSource = output<void>();
    readonly insertImage = output<void>();

    protected readonly linkOpen = signal(false);
    protected linkHref = '';

    /** The key currently bound to the markdown toggle, as printed on the button; computed off the bindings signal so rebinding it in Settings updates the hint rather than leaving it advertising a key that no longer does anything. */
    protected readonly markdownShortcut = computed(() => {
        const token = this.keybinds.getBinding('wiki-toggle-markdown');
        return token ? formatAccelerator(token).replace(/ \+ /g, '+') : '';
    });

    private readonly keybinds = inject(KeybindsService);

    protected readonly groups: ToolbarAction[][] = [
        [
            {label: 'B', titleKey: 'WIKI.FORMAT.BOLD', active: 'bold', className: 'font-bold', run: e => e.chain().focus().toggleBold().run()},
            {label: 'I', titleKey: 'WIKI.FORMAT.ITALIC', active: 'italic', className: 'italic', run: e => e.chain().focus().toggleItalic().run()},
            {label: 'U', titleKey: 'WIKI.FORMAT.UNDERLINE', active: 'underline', className: 'underline', run: e => e.chain().focus().toggleUnderline().run()},
            {label: 'S', titleKey: 'WIKI.FORMAT.STRIKETHROUGH', active: 'strike', className: 'line-through', run: e => e.chain().focus().toggleStrike().run()},
            {label: '<>', titleKey: 'WIKI.FORMAT.INLINE_CODE', active: 'code', className: 'font-mono text-[0.6875rem]', run: e => e.chain().focus().toggleCode().run()},
        ],
        [
            {label: 'H1', titleKey: 'WIKI.BLOCK.HEADING_1', active: 'heading', attrs: {level: 1}, className: 'text-[0.6875rem] font-bold', run: e => e.chain().focus().toggleHeading({level: 1}).run()},
            {label: 'H2', titleKey: 'WIKI.BLOCK.HEADING_2', active: 'heading', attrs: {level: 2}, className: 'text-[0.6875rem] font-bold', run: e => e.chain().focus().toggleHeading({level: 2}).run()},
            {label: 'H3', titleKey: 'WIKI.BLOCK.HEADING_3', active: 'heading', attrs: {level: 3}, className: 'text-[0.6875rem] font-bold', run: e => e.chain().focus().toggleHeading({level: 3}).run()},
        ],
        [
            {icon: 'pi-list', titleKey: 'WIKI.BLOCK.BULLET_LIST', active: 'bulletList', run: e => e.chain().focus().toggleBulletList().run()},
            {icon: 'pi-sort-numeric-up-alt', titleKey: 'WIKI.BLOCK.NUMBERED_LIST', active: 'orderedList', run: e => e.chain().focus().toggleOrderedList().run()},
            {icon: 'pi-check-square', titleKey: 'WIKI.BLOCK.TASK_LIST', active: 'taskList', run: e => e.chain().focus().toggleTaskList().run()},
        ],
        [
            {icon: 'pi-comment', titleKey: 'WIKI.BLOCK.QUOTE', active: 'blockquote', run: e => e.chain().focus().toggleBlockquote().run()},
            {icon: 'pi-code', titleKey: 'WIKI.BLOCK.CODE_BLOCK', active: 'codeBlock', run: e => e.chain().focus().toggleCodeBlock().run()},
            {icon: 'pi-table', titleKey: 'WIKI.BLOCK.TABLE', run: e => e.chain().focus().insertTable({rows: 3, cols: 3, withHeaderRow: true}).run()},
            {icon: 'pi-minus', titleKey: 'WIKI.BLOCK.DIVIDER', run: e => e.chain().focus().setHorizontalRule().run()},
        ],
        [
            {icon: 'pi-link', titleKey: 'WIKI.FORMAT.LINK', active: 'link', run: () => undefined},
            {icon: 'pi-image', titleKey: 'WIKI.FORMAT.IMAGE', run: () => undefined},
        ],
    ];

    protected isActive(action: ToolbarAction): boolean {
        if (!action.active || this.sourceMode()) return false;
        return this.editor()?.isActive(action.active, action.attrs) ?? false;
    }

    protected run(action: ToolbarAction): void {
        if (action.titleKey === 'WIKI.FORMAT.IMAGE') {
            this.insertImage.emit();
            return;
        }
        if (action.titleKey === 'WIKI.FORMAT.LINK') {
            this.openLink();
            return;
        }
        const editor = this.editor();
        if (editor) action.run(editor);
    }

    protected commitLink(): void {
        const editor = this.editor();
        const href = this.linkHref.trim();
        if (!editor || !href) {
            this.closeLink();
            return;
        }
        // extendMarkRange so clicking inside an existing link retargets the whole link rather than splitting it at the caret.
        editor.chain().focus().extendMarkRange('link').setLink({href}).run();
        this.closeLink();
    }

    protected removeLink(): void {
        this.editor()?.chain().focus().extendMarkRange('link').unsetLink().run();
        this.closeLink();
    }

    protected closeLink(): void {
        this.linkOpen.set(false);
        this.linkHref = '';
    }

    /** Public so the configurable Link shortcut opens the same row the button does. */
    openLinkRow(): void {
        this.openLink();
    }

    private openLink(): void {
        const editor = this.editor();
        if (!editor) return;
        this.linkHref = (editor.getAttributes('link')['href'] as string | undefined) ?? '';
        this.linkOpen.set(true);
    }
}
