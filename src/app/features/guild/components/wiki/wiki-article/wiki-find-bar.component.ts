import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    ElementRef,
    input,
    OnDestroy,
    output,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule} from '@ngx-translate/core';
import {Editor} from '@tiptap/core';
import {TextSelection} from '@tiptap/pm/state';
import {
    closeWikiFind,
    openWikiFind,
    setWikiFindQuery,
    wikiFindNext,
    wikiFindPrev,
    wikiFindReplace,
    wikiFindReplaceAll,
    wikiFindState,
    WikiFindState,
} from './wiki-find.plugin';

/**
 * Find and replace, docked to the top-right of the article column rather than floating: it has no
 * anchor in the document to track, and a bar that does not move is a bar that does not have to be
 * chased. Positioned with `absolute`, so the article's root element needs `relative`.
 *
 * Available in read mode too. Replace hides itself there, since the highlight is the only part
 * that works without an editable document.
 */
@Component({
    selector: 'app-wiki-find-bar',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [FormsModule, TranslateModule],
    host: {class: 'absolute right-6 top-3 z-40'},
    template: `
        @if (open()) {
            <div
                class="flex flex-col gap-1.5 rounded-xl border border-border bg-card px-2 py-1.5 shadow-xl"
                role="search"
            >
                <div class="flex items-center gap-1">
                    <i class="pi pi-search text-[0.75rem] text-text-muted"></i>
                    <input
                        #queryInput
                        (keydown)="onQueryKeydown($event)"
                        (ngModelChange)="onQuery($event)"
                        [ngModel]="query()"
                        [placeholder]="'WIKI.FIND.PLACEHOLDER' | translate"
                        aria-live="polite"
                        class="w-48 border-0 bg-transparent text-[0.8125rem] text-text-primary
                                  outline-none placeholder-white/25"
                    />
                    <span class="w-16 shrink-0 text-right text-[0.6875rem] tabular-nums text-text-muted">
                        {{ countLabel() }}
                    </span>

                    <button
                        (click)="toggleCase()"
                        [attr.aria-pressed]="caseSensitive()"
                        [class.bg-hover]="caseSensitive()"
                        [class.text-brand-dim]="caseSensitive()"
                        [title]="'WIKI.FIND.CASE_SENSITIVE' | translate"
                        class="h-6 w-6 cursor-pointer rounded border-0 bg-transparent
                                   font-mono text-[0.625rem] text-text-secondary hover:bg-hover"
                        type="button"
                    >
                        Aa
                    </button>
                    <button
                        (click)="toggleWholeWord()"
                        [attr.aria-pressed]="wholeWord()"
                        [class.bg-hover]="wholeWord()"
                        [class.text-brand-dim]="wholeWord()"
                        [title]="'WIKI.FIND.WHOLE_WORD' | translate"
                        class="h-6 w-6 cursor-pointer rounded border-0 bg-transparent
                                   font-mono text-[0.625rem] text-text-secondary hover:bg-hover"
                        type="button"
                    >
                        ab
                    </button>

                    <span class="mx-0.5 h-4 w-px bg-white/[0.12]"></span>

                    <button
                        (click)="prev()"
                        [title]="'WIKI.FIND.PREVIOUS' | translate"
                        class="flex h-6 w-6 cursor-pointer items-center justify-center rounded
                                   border-0 bg-transparent text-text-secondary hover:bg-hover
                                   hover:text-text-primary"
                        type="button"
                    >
                        <i class="pi pi-chevron-up text-[0.625rem]"></i>
                    </button>
                    <button
                        (click)="next()"
                        [title]="'WIKI.FIND.NEXT' | translate"
                        class="flex h-6 w-6 cursor-pointer items-center justify-center rounded
                                   border-0 bg-transparent text-text-secondary hover:bg-hover
                                   hover:text-text-primary"
                        type="button"
                    >
                        <i class="pi pi-chevron-down text-[0.625rem]"></i>
                    </button>
                    @if (canReplace()) {
                        <button
                            (click)="replaceOpen.set(!replaceOpen())"
                            [attr.aria-expanded]="replaceOpen()"
                            aria-controls="wiki-find-replace"
                            [title]="'WIKI.FIND.TOGGLE_REPLACE' | translate"
                            class="flex h-6 w-6 cursor-pointer items-center justify-center rounded
                                       border-0 bg-transparent text-text-secondary hover:bg-hover
                                       hover:text-text-primary"
                            type="button"
                        >
                            <i
                                [class]="replaceOpen() ? 'pi-chevron-left' : 'pi-pencil'"
                                class="pi text-[0.625rem]"
                            ></i>
                        </button>
                    }
                    <button
                        (click)="close(true)"
                        [title]="'WIKI.FIND.CLOSE' | translate"
                        class="flex h-6 w-6 cursor-pointer items-center justify-center rounded
                                   border-0 bg-transparent text-text-muted hover:bg-hover
                                   hover:text-text-primary"
                        type="button"
                    >
                        <i class="pi pi-times text-[0.625rem]"></i>
                    </button>
                </div>

                @if (replaceOpen() && canReplace()) {
                    <div class="flex items-center gap-1" id="wiki-find-replace">
                        <i class="pi pi-pencil text-[0.75rem] text-text-muted"></i>
                        <input
                            (keydown.escape)="close(true)"
                            [(ngModel)]="replacement"
                            [placeholder]="'WIKI.FIND.REPLACE_PLACEHOLDER' | translate"
                            class="w-48 border-0 bg-transparent text-[0.8125rem] text-text-primary
                                      outline-none placeholder-white/25"
                        />
                        <button
                            (click)="replaceCurrent()"
                            class="cursor-pointer rounded border-0 bg-white/[0.06] px-2 py-1
                                       text-[0.6875rem] text-text-secondary hover:bg-white/10
                                       hover:text-text-primary"
                            type="button"
                        >
                            {{ 'WIKI.FIND.REPLACE' | translate }}
                        </button>
                        <button
                            (click)="replaceAll()"
                            class="cursor-pointer rounded border-0 bg-brand/20 px-2 py-1
                                       text-[0.6875rem] font-medium text-brand-dim hover:bg-brand/30"
                            type="button"
                        >
                            {{ 'WIKI.FIND.REPLACE_ALL' | translate }}
                        </button>
                    </div>
                }
            </div>
        }
    `,
})
export class WikiFindBarComponent implements OnDestroy {
    readonly editor = input<Editor | undefined>(undefined);
    readonly open = input(false);
    /** Whether the article is in edit mode. Replace is hidden and refused when it is not. */
    readonly editable = input(false);

    readonly closed = output<void>();

    protected readonly query = signal('');
    protected readonly caseSensitive = signal(false);
    protected readonly wholeWord = signal(false);
    protected readonly replaceOpen = signal(false);
    protected replacement = '';

    /** Mirrors plugin state; bumped from the editor's transaction stream. */
    protected readonly findState = signal<WikiFindState | null>(null);

    /** An input, not `editor.isEditable`: that is a plain field, so leaving edit mode would leave
     * the replace controls on screen against a document that refuses them. */
    protected readonly canReplace = computed(() => this.editable());

    protected readonly countLabel = computed(() => {
        const state = this.findState();
        if (!state || !state.query) return '';
        if (!state.matches.length) return '0';
        return `${state.current + 1} / ${state.matches.length}`;
    });

    private readonly queryInput = viewChild<ElementRef<HTMLInputElement>>('queryInput');
    /** Where the caret was when the bar opened, so Escape can put it back. */
    private caret: {from: number; to: number} | null = null;
    private watching?: Editor;
    private readonly onTransaction = () => {
        const editor = this.watching;
        if (editor) this.findState.set(wikiFindState(editor.state));
    };

    constructor() {
        effect(() => {
            const editor = this.editor();
            if (editor === this.watching) return;
            this.watching?.off('transaction', this.onTransaction);
            this.watching = editor;
            editor?.on('transaction', this.onTransaction);
        });

        effect(() => {
            const editor = this.editor();
            const open = this.open();
            if (!editor) return;
            if (open) {
                const {from, to} = editor.state.selection;
                this.caret = {from, to};
                // untracked: read tracked, this effect would re-open on every keystroke and throw
                // the current match back to the first one.
                openWikiFind(editor.view, untracked(this.query));
                this.findState.set(wikiFindState(editor.state));
            } else {
                closeWikiFind(editor.view);
            }
        });

        // The field owns the keyboard while the bar is up, so it has to take focus on open.
        effect(() => {
            if (this.open()) this.queryInput()?.nativeElement.select();
        });
    }

    ngOnDestroy(): void {
        this.watching?.off('transaction', this.onTransaction);
    }

    /** Public so the article can seed the bar from a selection when Ctrl+F is pressed. */
    setQuery(query: string): void {
        this.onQuery(query);
    }

    protected onQuery(value: string): void {
        this.query.set(value);
        this.push({query: value});
    }

    protected toggleCase(): void {
        this.caseSensitive.update(v => !v);
        this.push({caseSensitive: this.caseSensitive()});
    }

    protected toggleWholeWord(): void {
        this.wholeWord.update(v => !v);
        this.push({wholeWord: this.wholeWord()});
    }

    protected onQueryKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.preventDefault();
            this.close(true);
            return;
        }
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (event.shiftKey) this.prev();
        else this.next();
    }

    protected next(): void {
        const editor = this.editor();
        if (editor) wikiFindNext(editor.view);
        this.refocus();
    }

    protected prev(): void {
        const editor = this.editor();
        if (editor) wikiFindPrev(editor.view);
        this.refocus();
    }

    protected replaceCurrent(): void {
        const editor = this.editor();
        if (editor) wikiFindReplace(editor.view, this.replacement);
    }

    protected replaceAll(): void {
        const editor = this.editor();
        if (editor) wikiFindReplaceAll(editor.view, this.replacement);
    }

    protected close(restoreCaret: boolean): void {
        const editor = this.editor();
        if (editor) {
            closeWikiFind(editor.view);
            const caret = this.caret;
            if (restoreCaret && caret) {
                const size = editor.state.doc.content.size;
                const from = Math.min(caret.from, size);
                const to = Math.min(caret.to, size);
                const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to));
                editor.view.dispatch(tr);
                editor.view.focus();
            }
        }
        this.caret = null;
        this.closed.emit();
    }

    private push(patch: Partial<{query: string; caseSensitive: boolean; wholeWord: boolean}>): void {
        const editor = this.editor();
        if (!editor || !this.open()) return;
        setWikiFindQuery(editor.view, patch);
    }

    /** Cycling moves the document selection, which would otherwise steal focus out of the field. */
    private refocus(): void {
        this.queryInput()?.nativeElement.focus();
    }
}
