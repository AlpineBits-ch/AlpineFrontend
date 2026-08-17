import {Component, input, output, signal} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {Editor} from '@tiptap/core';
import {SUPPORTED_LANGUAGES} from '../../../../../models/language.model';
import {WikiAiTransformAction} from '../wiki-ai/wiki-ai-shared';

interface BubbleAction {
    label: string;
    titleKey: string;
    mark: string;
    attrs?: Record<string, unknown>;
    run: (editor: Editor) => void;
    className?: string;
}

interface AiItem extends WikiAiTransformAction {
    labelKey: string;
    icon: string;
    /** Items that open a second level instead of running immediately. */
    submenu?: 'tone' | 'translate';
}

interface SubmenuOption {
    id: string;
    /** A literal string when the option names itself (a language endonym), otherwise null. */
    label: string | null;
    labelKey: string;
    action: WikiAiTransformAction;
}

/** English names for the languages we ship locales for: the picker shows the endonym, since that is what a person recognises, but the model is told the English name. Anything added to SUPPORTED_LANGUAGES without an entry here still works; it just sends its own label. */
const LANGUAGE_NAMES: Record<string, string> = {en: 'English', de: 'German', fr: 'French'};

const TONES: readonly {instruction: string; labelKey: string}[] = [
    {instruction: 'friendly', labelKey: 'WIKI.AI.TONE.FRIENDLY'},
    {instruction: 'formal', labelKey: 'WIKI.AI.TONE.FORMAL'},
    {instruction: 'concise', labelKey: 'WIKI.AI.TONE.CONCISE'},
];

/** Inline formatting and the AI actions that only make sense on a selection; replaces the always-visible half of the old 20-button toolbar, since those actions were meaningless without one. The AI half sits behind one sparkles button rather than as six more icons, and emits an intent only: the article routes it to the inline bar, which owns the document while the rewrite streams in and can put the selection back if rejected. */
@Component({
    selector: 'app-wiki-bubble-menu',
    imports: [TranslateModule],
    template: `
        @if (visible()) {
            <!-- mousedown is swallowed for the whole bar: pressing a button otherwise blurs the editor and collapses the selection before the click handler runs. -->
            <div
                (mousedown)="$event.preventDefault()"
                [style.left.px]="position().left"
                [style.top.px]="position().top"
                class="fixed z-50 -translate-x-1/2 -translate-y-full"
            >
                <div
                    class="flex items-center gap-0.5 rounded-lg border border-border bg-card
                            px-1 py-1 shadow-xl"
                >
                    @for (action of actions; track action.titleKey) {
                        <button
                            (click)="apply(action)"
                            [class.text-brand-dim]="isActive(action)"
                            [class]="action.className"
                            [title]="action.titleKey | translate"
                            class="flex h-7 min-w-7 cursor-pointer items-center justify-center
                                       rounded-md border-0 bg-transparent px-1.5 text-white/55
                                       transition-colors hover:bg-hover hover:text-white/90"
                        >
                            {{ action.label }}
                        </button>
                    }

                    <!-- Divider between formatting ("change these characters") and AI ("ask a model to rewrite them"); different kinds of act. -->
                    <span class="mx-0.5 h-4 w-px bg-white/[0.12]"></span>

                    <button
                        (click)="toggleAiMenu()"
                        [class.bg-hover]="aiMenuOpen()"
                        [title]="'WIKI.AI.MENU_TITLE' | translate"
                        class="flex h-7 cursor-pointer items-center gap-1 rounded-md border-0
                                   bg-transparent px-1.5 text-brand-dim transition-colors
                                   hover:bg-hover"
                    >
                        <i class="pi pi-sparkles text-[0.75rem]"></i>
                        <i class="pi pi-angle-down text-[0.5rem] opacity-60"></i>
                    </button>
                </div>

                @if (aiMenuOpen()) {
                    <!-- mousedown is swallowed so the editor never blurs: the selection this menu is about is the selection the action needs a moment later. -->
                    <div
                        (mousedown)="$event.preventDefault()"
                        class="absolute left-1/2 top-full mt-1 w-56 -translate-x-1/2
                                overflow-hidden rounded-xl border border-border bg-card py-1
                                shadow-xl"
                    >
                        @if (submenu() === null) {
                            @for (item of aiItems; track item.labelKey) {
                                <button
                                    (click)="chooseAi(item)"
                                    class="flex w-full cursor-pointer items-center gap-2.5
                                               border-0 bg-transparent px-3 py-2 text-left
                                               text-[0.8125rem] text-white/75 hover:bg-hover"
                                >
                                    <i [class]="item.icon" class="pi text-[0.75rem] text-white/40"></i>
                                    <span class="flex-1">{{ item.labelKey | translate }}</span>
                                    @if (item.submenu) {
                                        <i class="pi pi-angle-right text-[0.625rem] text-white/25"></i>
                                    }
                                </button>
                            }
                        } @else {
                            <button
                                (click)="submenu.set(null)"
                                class="flex w-full cursor-pointer items-center gap-2 border-0
                                           bg-transparent px-3 py-1.5 text-left text-[0.6875rem]
                                           text-white/35 hover:text-white/70"
                            >
                                <i class="pi pi-angle-left text-[0.625rem]"></i>
                                {{ 'COMMON.BACK' | translate }}
                            </button>
                            <div class="max-h-56 overflow-y-auto thin-scrollbar">
                                @for (option of submenuItems(); track option.id) {
                                    <button
                                        (click)="emit(option.action)"
                                        class="flex w-full cursor-pointer items-center gap-2.5
                                                   border-0 bg-transparent px-3 py-2 text-left
                                                   text-[0.8125rem] text-white/75 hover:bg-hover"
                                    >
                                        <span class="flex-1">
                                            {{ option.label ?? (option.labelKey | translate) }}
                                        </span>
                                    </button>
                                }
                            </div>
                        }
                    </div>
                }
            </div>
        }
    `,
})
export class WikiBubbleMenuComponent {
    readonly editor = input<Editor | undefined>(undefined);

    /** An intent, not an edit. The article hands it to the inline AI bar. */
    readonly aiAction = output<WikiAiTransformAction>();

    protected readonly visible = signal(false);
    protected readonly position = signal({top: 0, left: 0});
    protected readonly aiMenuOpen = signal(false);
    protected readonly submenu = signal<'tone' | 'translate' | null>(null);

    protected readonly actions: BubbleAction[] = [
        {
            label: 'B',
            titleKey: 'WIKI.FORMAT.BOLD',
            mark: 'bold',
            className: 'font-bold',
            run: e => e.chain().focus().toggleBold().run(),
        },
        {
            label: 'I',
            titleKey: 'WIKI.FORMAT.ITALIC',
            mark: 'italic',
            className: 'italic',
            run: e => e.chain().focus().toggleItalic().run(),
        },
        {
            label: 'U',
            titleKey: 'WIKI.FORMAT.UNDERLINE',
            mark: 'underline',
            className: 'underline',
            run: e => e.chain().focus().toggleUnderline().run(),
        },
        {
            label: 'S',
            titleKey: 'WIKI.FORMAT.STRIKETHROUGH',
            mark: 'strike',
            className: 'line-through',
            run: e => e.chain().focus().toggleStrike().run(),
        },
        {
            label: '<>',
            titleKey: 'WIKI.FORMAT.INLINE_CODE',
            mark: 'code',
            className: 'font-mono text-[0.6875rem]',
            run: e => e.chain().focus().toggleCode().run(),
        },
        {
            label: 'H1',
            titleKey: 'WIKI.BLOCK.HEADING_1',
            mark: 'heading',
            attrs: {level: 1},
            className: 'text-[0.6875rem] font-bold',
            run: e => e.chain().focus().toggleHeading({level: 1}).run(),
        },
        {
            label: 'H2',
            titleKey: 'WIKI.BLOCK.HEADING_2',
            mark: 'heading',
            attrs: {level: 2},
            className: 'text-[0.6875rem] font-bold',
            run: e => e.chain().focus().toggleHeading({level: 2}).run(),
        },
        {
            label: 'H3',
            titleKey: 'WIKI.BLOCK.HEADING_3',
            mark: 'heading',
            attrs: {level: 3},
            className: 'text-[0.6875rem] font-bold',
            run: e => e.chain().focus().toggleHeading({level: 3}).run(),
        },
        {
            label: '❝',
            titleKey: 'WIKI.BLOCK.QUOTE',
            mark: 'blockquote',
            run: e => e.chain().focus().toggleBlockquote().run(),
        },
    ];

    protected readonly aiItems: AiItem[] = [
        {op: 'improve', labelKey: 'WIKI.AI.OP.IMPROVE', icon: 'pi-sparkles'},
        {op: 'shorten', labelKey: 'WIKI.AI.OP.SHORTEN', icon: 'pi-minus'},
        {op: 'expand', labelKey: 'WIKI.AI.OP.EXPAND', icon: 'pi-plus'},
        {op: 'grammar', labelKey: 'WIKI.AI.OP.GRAMMAR', icon: 'pi-check'},
        {op: 'tone', labelKey: 'WIKI.AI.OP.TONE', icon: 'pi-palette', submenu: 'tone'},
        {op: 'translate', labelKey: 'WIKI.AI.OP.TRANSLATE', icon: 'pi-globe', submenu: 'translate'},
    ];

    /** Called by the article on every selection change. */
    sync(): void {
        const editor = this.editor();
        if (!editor || !editor.isEditable) {
            this.hide();
            return;
        }
        const {from, to, empty} = editor.state.selection;
        if (empty || from === to) {
            this.hide();
            return;
        }
        const start = editor.view.coordsAtPos(from);
        const end = editor.view.coordsAtPos(to);
        this.position.set({
            top: Math.min(start.top, end.top) - 8,
            left: (start.left + end.left) / 2,
        });
        this.visible.set(true);
    }

    protected isActive(action: BubbleAction): boolean {
        return this.editor()?.isActive(action.mark, action.attrs) ?? false;
    }

    protected apply(action: BubbleAction): void {
        const editor = this.editor();
        if (editor) action.run(editor);
    }

    protected toggleAiMenu(): void {
        this.submenu.set(null);
        this.aiMenuOpen.update(open => !open);
    }

    protected chooseAi(item: AiItem): void {
        if (item.submenu) {
            this.submenu.set(item.submenu);
            return;
        }
        this.emit({op: item.op, labelKey: item.labelKey});
    }

    /** `label` set means render it as-is; otherwise `labelKey` is translated. */
    protected submenuItems(): SubmenuOption[] {
        if (this.submenu() === 'tone') {
            return TONES.map(tone => ({
                id: tone.instruction,
                label: null,
                labelKey: tone.labelKey,
                action: {op: 'tone' as const, instruction: tone.instruction, labelKey: 'WIKI.AI.OP.TONE'},
            }));
        }
        return SUPPORTED_LANGUAGES.map(language => ({
            id: language.code,
            // Endonyms are already in their own language; translating them would be a round trip back to the same word.
            label: language.label,
            labelKey: '',
            action: {
                op: 'translate' as const,
                instruction: LANGUAGE_NAMES[language.code] ?? language.label,
                labelKey: 'WIKI.AI.OP.TRANSLATE',
            },
        }));
    }

    protected emit(action: WikiAiTransformAction): void {
        this.aiAction.emit(action);
        this.hide();
    }

    /** Public because the article suppresses the menu for the length of a selection drag. */
    hide(): void {
        this.visible.set(false);
        this.aiMenuOpen.set(false);
        this.submenu.set(null);
    }
}
