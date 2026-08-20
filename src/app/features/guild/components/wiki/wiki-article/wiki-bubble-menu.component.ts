import {Component, ElementRef, input, output, signal, viewChild} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {Editor} from '@tiptap/core';
import {SUPPORTED_LANGUAGES} from '../../../../../models/language.model';
import {WikiAiTransformAction} from '../wiki-ai/wiki-ai-shared';
import {
    isFormatActive,
    WIKI_BUBBLE_BLOCK_IDS,
    WIKI_FORMAT_ACTIONS,
    WIKI_INLINE_FORMAT_IDS,
    WikiFormatAction,
} from './wiki-format-actions';
import {anchorTo, AnchorRect, injectWikiFloating} from './wiki-floating';

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

/** Used until the bar has been laid out once; the measured size replaces it on the next frame. */
const BAR_SIZE = {width: 300, height: 36};

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
            <!-- No translate on the container: anchorTo already returns the flipped, clamped top, and a transform on top of it would move the bar back off the viewport on the first line of the page. -->
            <div
                #panel
                (mousedown)="$event.preventDefault()"
                [style.left.px]="position().left"
                [style.top.px]="position().top"
                class="fixed z-50"
            >
                <div
                    class="flex items-center gap-0.5 rounded-lg border border-border bg-card
                            px-1 py-1 shadow-xl"
                >
                    @for (action of actions; track action.id) {
                        <button
                            (click)="apply(action)"
                            [attr.aria-pressed]="isActive(action)"
                            [class.text-brand-dim]="isActive(action)"
                            [class]="action.className"
                            [title]="action.titleKey | translate"
                            class="flex h-7 min-w-7 cursor-pointer items-center justify-center
                                       rounded-md border-0 bg-transparent px-1.5 text-text-secondary
                                       transition-colors hover:bg-hover hover:text-text-primary"
                            type="button"
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
                                               text-[0.8125rem] text-text-primary hover:bg-hover"
                                >
                                    <i [class]="item.icon" class="pi text-[0.75rem] text-text-muted"></i>
                                    <span class="flex-1">{{ item.labelKey | translate }}</span>
                                    @if (item.submenu) {
                                        <i class="pi pi-angle-right text-[0.625rem] text-text-muted"></i>
                                    }
                                </button>
                            }
                        } @else {
                            <button
                                (click)="submenu.set(null)"
                                class="flex w-full cursor-pointer items-center gap-2 border-0
                                           bg-transparent px-3 py-1.5 text-left text-[0.6875rem]
                                           text-text-muted hover:text-text-primary"
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
                                                   text-[0.8125rem] text-text-primary hover:bg-hover"
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

    private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
    private actionCache?: WikiFormatAction[];
    /** The selection rect the bar hangs off, kept so a scroll can re-place it. */
    private anchor: AnchorRect | null = null;

    private readonly floating = injectWikiFloating({
        reposition: () => this.place(),
        close: () => this.hide(),
        contains: node => this.panel()?.nativeElement.contains(node) ?? false,
        // Escape reaches this component through the article's own menu chain.
        escape: false,
    });

    protected get actions(): WikiFormatAction[] {
        return (this.actionCache ??= [...WIKI_INLINE_FORMAT_IDS, ...WIKI_BUBBLE_BLOCK_IDS].map(
            id => WIKI_FORMAT_ACTIONS[id],
        ));
    }

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
        this.anchor = {
            top: Math.min(start.top, end.top),
            bottom: Math.max(start.bottom, end.bottom),
            left: Math.min(start.left, end.left),
            right: Math.max(start.left, end.left),
        };
        this.place();
        this.visible.set(true);
        this.floating.attach();
        // The panel does not exist until this render, so the first placement uses the estimate
        // above and this one uses what was actually laid out.
        requestAnimationFrame(() => {
            if (this.visible()) this.place();
        });
    }

    protected isActive(action: WikiFormatAction): boolean {
        return isFormatActive(action, this.editor());
    }

    protected apply(action: WikiFormatAction): void {
        const editor = this.editor();
        if (editor) action.run?.(editor);
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

    /** Public because Escape has to reach the bar, and the article is what sees the key. */
    isVisible(): boolean {
        return this.visible();
    }

    /** Public because the article suppresses the menu for the length of a selection drag. */
    hide(): void {
        this.floating.detach();
        this.anchor = null;
        this.visible.set(false);
        this.aiMenuOpen.set(false);
        this.submenu.set(null);
    }

    private place(): void {
        const anchor = this.anchor;
        if (!anchor) return;
        const element = this.panel()?.nativeElement;
        const size = {
            width: element?.offsetWidth || BAR_SIZE.width,
            height: element?.offsetHeight || BAR_SIZE.height,
        };
        this.position.set(anchorTo(anchor, size, {align: 'center', prefer: 'above'}));
    }
}
