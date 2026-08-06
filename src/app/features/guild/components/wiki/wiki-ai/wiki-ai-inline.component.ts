import {
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
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Editor} from '@tiptap/core';
import {AI_PROVIDER_META, stripOuterFence} from '../../../../../services/ai-provider';
import {AiConnectFormComponent} from '../../../../../shared/ai-connect-form/ai-connect-form.component';
import {WikiAiService} from '../wiki-ai.service';
import {WikiAiDocStream} from './wiki-ai-doc-stream';
import {
    describeAiError,
    isMissingProvider,
    markdownForRange,
    resolveTransformScope,
    WikiAiTransformAction,
} from './wiki-ai-shared';

type InlinePhase = 'closed' | 'prompt' | 'running' | 'review' | 'connect';

/** How often the accumulated text is re-parsed into the document while streaming. */
const FLUSH_MS = 90;

/**
 * Generation at the caret, written into the page as it arrives.
 *
 * This is the surface that replaces "open a dialog, read a preview, press Insert". The result
 * lands in the document in the document's own typography, beside the paragraph it has to live
 * next to, and the strip underneath is the only decision left: keep it, ask again, change it, or
 * take it back. {@link WikiAiDocStream} is what makes "take it back" exact and what keeps the
 * whole generation to a single ⌘Z.
 *
 * The article drives it imperatively - {@link askAtCaret}, {@link runTransform},
 * {@link draftIntoPage}, {@link cancel} - because every entry point (⌘J, the bubble menu, the
 * draft dialog) already lives in the article's own keyboard and menu wiring.
 */
@Component({
    selector: 'app-wiki-ai-inline',
    imports: [FormsModule, TranslateModule, AiConnectFormComponent],
    template: `
        @if (phase() !== 'closed') {
            <div (mousedown)="$event.stopPropagation()"
                 [style.left.px]="position().left" [style.top.px]="position().top"
                 class="fixed z-50 w-[26rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl
                        border border-border bg-card shadow-2xl">

                <!-- Connect, reached without leaving the page you were writing on. -->
                @if (phase() === 'connect') {
                    <div class="max-h-[70vh] overflow-y-auto p-3 thin-scrollbar">
                        <p class="mb-3 text-[0.75rem] text-white/50">
                            {{ 'WIKI.AI.CONNECT_INTRO' | translate }}
                        </p>
                        <app-ai-connect-form (connected)="onConnected()" [showBilling]="false"/>
                        <button (click)="close()"
                                class="mt-3 cursor-pointer border-0 bg-transparent p-0
                                       text-[0.75rem] text-white/40 hover:text-white/70"
                                type="button">{{ 'COMMON.CANCEL' | translate }}
                        </button>
                    </div>
                } @else {
                    <div class="flex flex-col gap-2 p-2">

                        <!-- What is happening, in the same slot in every phase. -->
                        <div class="flex items-center gap-2 px-1">
                            <i [class.pi-spin]="phase() === 'running'"
                               [class]="phase() === 'running' ? 'pi-spinner' : 'pi-sparkles'"
                               class="pi text-[0.75rem] text-brand-dim"></i>
                            <span class="flex-1 truncate text-[0.6875rem] text-white/40">
                                @if (phase() === 'running') {
                                    {{ (runningLabel() || 'WIKI.AI.INLINE.GENERATING') | translate }}
                                } @else if (phase() === 'review') {
                                    {{ 'WIKI.AI.INLINE.REVIEW' | translate }}
                                } @else {
                                    {{ 'WIKI.AI.INLINE.TITLE' | translate }}
                                }
                            </span>
                            @if (phase() !== 'running' && ai.activeProvider()) {
                                <button (click)="phase.set('connect')"
                                        class="cursor-pointer border-0 bg-transparent p-0
                                               text-[0.6875rem] text-white/25 hover:text-white/60"
                                        type="button">{{ providerLabel() }}
                                </button>
                            }
                        </div>

                        @if (phase() === 'prompt' || phase() === 'review') {
                            <div class="flex items-center gap-1.5 rounded-lg border border-border
                                        bg-app-bg px-2 py-1.5">
                                <input #barInput
                                       (keydown.enter)="submit()"
                                       (keydown.escape)="close()"
                                       [(ngModel)]="draftPrompt"
                                       [placeholder]="(phase() === 'review'
                                            ? 'WIKI.AI.INLINE.REFINE_PLACEHOLDER'
                                            : 'WIKI.AI.INLINE.PROMPT_PLACEHOLDER') | translate"
                                       class="flex-1 border-0 bg-transparent text-[0.8125rem]
                                              text-white/85 outline-none placeholder-white/25"/>
                                <button (click)="submit()"
                                        class="flex h-6 w-6 shrink-0 cursor-pointer items-center
                                               justify-center rounded-md border-0 bg-brand/20
                                               text-brand-dim hover:bg-brand/30"
                                        [title]="'WIKI.AI.INLINE.SEND' | translate" type="button">
                                    <i class="pi pi-arrow-up text-[0.625rem]"></i>
                                </button>
                            </div>
                        }

                        @if (error(); as message) {
                            <p class="rounded-lg border border-offline/30 bg-offline/[0.08] px-2
                                      py-1.5 text-[0.75rem] leading-snug text-white/70">
                                {{ message }}
                            </p>
                        }

                        <!-- Control strip. One row, one decision each. -->
                        <div class="flex items-center gap-1 px-0.5">
                            @if (phase() === 'running') {
                                <button (click)="stop()"
                                        class="flex cursor-pointer items-center gap-1.5 rounded-md
                                               border-0 bg-white/[0.06] px-2 py-1 text-[0.75rem]
                                               text-white/65 hover:bg-white/10 hover:text-white/90"
                                        type="button">
                                    <i class="pi pi-stop text-[0.625rem]"></i>
                                    {{ 'WIKI.AI.STOP' | translate }}
                                </button>
                            } @else if (phase() === 'review') {
                                <button (click)="accept()"
                                        class="flex cursor-pointer items-center gap-1.5 rounded-md
                                               border-0 bg-brand/20 px-2 py-1 text-[0.75rem]
                                               text-brand-dim hover:bg-brand/30"
                                        type="button">
                                    <i class="pi pi-check text-[0.625rem]"></i>
                                    {{ 'WIKI.AI.INLINE.ACCEPT' | translate }}
                                </button>
                                <button (click)="retry()"
                                        class="flex cursor-pointer items-center gap-1.5 rounded-md
                                               border-0 bg-white/[0.06] px-2 py-1 text-[0.75rem]
                                               text-white/65 hover:bg-white/10 hover:text-white/90"
                                        type="button">
                                    <i class="pi pi-refresh text-[0.625rem]"></i>
                                    {{ 'WIKI.AI.INLINE.RETRY' | translate }}
                                </button>
                                <button (click)="close()"
                                        class="flex cursor-pointer items-center gap-1.5 rounded-md
                                               border-0 bg-white/[0.06] px-2 py-1 text-[0.75rem]
                                               text-white/65 hover:bg-white/10 hover:text-white/90"
                                        type="button">
                                    <i class="pi pi-times text-[0.625rem]"></i>
                                    {{ 'WIKI.AI.INLINE.DISCARD' | translate }}
                                </button>
                            } @else {
                                <span class="px-1 text-[0.6875rem] text-white/25">
                                    {{ 'WIKI.AI.INLINE.HINT' | translate }}
                                </span>
                                @if (!ai.available()) {
                                    <button (click)="phase.set('connect')"
                                            class="ml-auto cursor-pointer border-0 bg-transparent
                                                   p-0 text-[0.6875rem] text-brand-dim
                                                   hover:underline" type="button">
                                        {{ 'WIKI.AI.INLINE.NOT_CONNECTED' | translate }}
                                    </button>
                                }
                            }
                        </div>
                    </div>
                }
            </div>
        }
    `,
})
export class WikiAiInlineComponent implements OnDestroy {
    readonly editor = input<Editor | undefined>(undefined);
    readonly pageTitle = input('');
    readonly pageTitles = input<readonly string[]>([]);
    /**
     * Whether the article is in edit mode. Read when a generation ends, to hand the editable
     * flag back to whatever the article wants it to be by then rather than to what it was when
     * the generation started.
     */
    readonly editable = input(true);

    /** Emitted whenever the bar leaves the screen, accepted or not. */
    readonly closed = output<void>();
    /** Emitted only when generated text was kept, so the article can mark the page dirty. */
    readonly applied = output<void>();

    protected readonly ai = inject(WikiAiService);
    private readonly translate = inject(TranslateService);
    protected readonly phase = signal<InlinePhase>('closed');
    protected readonly position = signal({top: 0, left: 0});
    protected readonly error = signal<string | null>(null);
    /** A translation key naming the running action, when it came from the bubble menu. */
    protected readonly runningLabel = signal<string | null>(null);
    protected draftPrompt = '';

    protected readonly providerLabel = computed(() => {
        const id = this.ai.activeProvider();
        return id ? AI_PROVIDER_META[id].label : '';
    });

    /** True while the bar owns the document. The article uses it to hold other menus back. */
    readonly active = computed(() => this.phase() !== 'closed');

    private readonly barInput = viewChild<ElementRef<HTMLInputElement>>('barInput');

    private stream?: WikiAiDocStream;
    private controller?: AbortController;
    private flushTimer?: ReturnType<typeof setTimeout>;
    /** The accumulated model output. Not a signal: the document is the view of it. */
    private output = '';
    /** The markdown the bar opened over, when it opened over a selection rather than a caret. */
    private sourceText = '';
    /** Re-runnable form of the last request, for Retry and for a retry after connecting. */
    private lastRun: (() => AsyncIterable<string>) | null = null;

    constructor() {
        effect(() => {
            const phase = this.phase();
            const input = this.barInput();
            if (input && (phase === 'prompt' || phase === 'review')) {
                input.nativeElement.focus();
            }
        });
    }

    /**
     * Opens the bar at the caret with an empty prompt. A non-empty selection is treated as the
     * target to rewrite, so ⌘J over a paragraph means "do something with this".
     */
    askAtCaret(): void {
        const editor = this.editor();
        if (!editor || !editor.isEditable) return;
        void this.ai.refresh();
        const {from, to} = editor.state.selection;
        this.begin(from, to);
        this.sourceText = from === to ? '' : markdownForRange(editor, from, to);
        this.draftPrompt = '';
        this.runningLabel.set(null);
        this.lastRun = null;
        this.phase.set('prompt');
    }

    /**
     * Runs a menu action. Starts immediately: the user has already said what they want by picking
     * the item.
     *
     * What it runs against is {@link resolveTransformScope}'s problem, because the two menus that
     * reach here disagree - the bubble menu only appears over a selection, the slash menu only
     * ever leaves a caret.
     */
    runTransform(action: WikiAiTransformAction): void {
        const editor = this.editor();
        if (!editor || !editor.isEditable) return;
        void this.ai.refresh();

        const scope = resolveTransformScope(editor, action.op);
        if (!scope) {
            // An empty page has nothing to improve. Said out loud, next to the caret, with the
            // prompt field open - the failure the user reported was this case saying nothing.
            const {from, to} = editor.state.selection;
            this.begin(from, to);
            this.draftPrompt = '';
            this.runningLabel.set(null);
            this.lastRun = null;
            this.error.set(this.translate.instant('WIKI.AI.INLINE.NOTHING_TO_TRANSFORM'));
            this.phase.set('prompt');
            return;
        }

        this.begin(scope.from, scope.to);
        this.draftPrompt = '';
        this.runningLabel.set(action.labelKey ?? null);
        this.start(() => this.ai.transform({
            op: action.op,
            text: scope.text,
            instruction: action.instruction,
            title: this.pageTitle(),
            pageTitles: this.pageTitles(),
        }, this.abortSignal()));
    }

    /**
     * Streams a whole-page draft from the dialog's prompt into the page itself.
     *
     * An empty page hands over its entire body, because that is what "draft this page" means
     * there. A page with content is inserted into at the caret instead - replacing a written
     * page from a one-line prompt is a decision that belongs behind the dialog's explicit
     * Replace button, not behind a stream that has already started.
     */
    draftIntoPage(prompt: string): void {
        const editor = this.editor();
        if (!editor || !prompt.trim()) return;
        void this.ai.refresh();
        const empty = !editor.state.doc.textContent.trim();
        const {from, to} = empty
            ? {from: 0, to: editor.state.doc.content.size}
            : editor.state.selection;
        const existingContent = empty ? '' : editor.getMarkdown();
        this.begin(from, to);
        this.draftPrompt = prompt;
        this.runningLabel.set(null);
        this.start(() => this.ai.draft({
            prompt,
            title: this.pageTitle(),
            existingContent,
            pageTitles: this.pageTitles(),
        }, this.abortSignal()));
    }

    /** Aborts, restores the document and closes. Safe to call when nothing is open. */
    cancel(): void {
        if (this.phase() === 'closed') return;
        this.close();
    }

    /**
     * Drops the pending work without touching the document.
     *
     * Deliberately not `close()`: leaving the wiki mid-generation destroys the editor, and a
     * discard would then rewind a surface whose view is already gone. The coalescing timer is the
     * one that outlives us - it fires up to {@link FLUSH_MS} later, straight into a dead editor.
     */
    ngOnDestroy(): void {
        this.flushTimer = clearTimer(this.flushTimer);
        this.controller?.abort();
        this.stream = undefined;
    }

    protected submit(): void {
        const words = this.draftPrompt.trim();
        if (!words) return;
        if (this.phase() === 'review') {
            // Refining works on what was generated, not on what the page held before it.
            const text = stripOuterFence(this.output);
            this.draftPrompt = '';
            this.start(() => this.ai.transform({
                op: 'improve',
                text,
                instruction: words,
                title: this.pageTitle(),
                pageTitles: this.pageTitles(),
            }, this.abortSignal()));
            return;
        }
        if (this.sourceText) {
            // Opened over a selection: the instruction is about that passage, so the passage has
            // to travel with it. Sending this as a draft would have the model write something new
            // over text it never saw.
            const text = this.sourceText;
            this.start(() => this.ai.transform({
                op: 'improve',
                text,
                instruction: words,
                title: this.pageTitle(),
                pageTitles: this.pageTitles(),
            }, this.abortSignal()));
            return;
        }
        this.start(() => this.ai.draft({
            prompt: words,
            title: this.pageTitle(),
            // Deliberately not the page body. `buildDraftPrompt` labels it "existing content to
            // revise", and an insertion at the caret is not a request to revise the page.
            existingContent: '',
            pageTitles: this.pageTitles(),
        }, this.abortSignal()));
    }

    protected retry(): void {
        const run = this.lastRun;
        if (run) this.start(run);
    }

    protected stop(): void {
        this.controller?.abort();
    }

    protected accept(): void {
        const text = stripOuterFence(this.output).trim();
        this.flushTimer = clearTimer(this.flushTimer);
        this.controller?.abort();
        if (text) {
            this.stream?.accept(text);
            this.applied.emit();
        } else {
            this.stream?.discard();
        }
        this.reset();
    }

    protected close(): void {
        this.flushTimer = clearTimer(this.flushTimer);
        this.controller?.abort();
        this.stream?.discard();
        this.reset();
    }

    protected onConnected(): void {
        this.error.set(null);
        // Connecting mid-request is a retry, not a fresh start: the user already said what they
        // wanted and had it refused for a reason that no longer applies.
        if (this.lastRun) this.start(this.lastRun);
        else this.phase.set('prompt');
    }

    /** Captures the range this generation owns and parks the bar next to it. */
    private begin(from: number, to: number): void {
        const editor = this.editor();
        if (!editor) return;
        if (this.stream?.active) this.stream.discard();
        this.output = '';
        this.sourceText = '';
        this.error.set(null);
        this.stream = new WikiAiDocStream(editor, () => this.editable());
        this.stream.begin(from, to);
        this.reposition();
    }

    private async start(run: () => AsyncIterable<string>): Promise<void> {
        if (!this.stream?.active) return;
        this.lastRun = run;
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        this.error.set(null);
        this.output = '';
        this.stream.rewind();
        this.phase.set('running');

        try {
            for await (const chunk of run()) {
                if (controller.signal.aborted) break;
                this.output += chunk;
                this.scheduleFlush();
            }
            this.flushNow();
            this.settle();
        } catch (err) {
            this.flushNow();
            if (controller.signal.aborted) {
                // Stop is a decision, not a failure. Whatever arrived stays for review.
                this.settle();
                return;
            }
            if (isMissingProvider(err)) {
                this.phase.set('connect');
                return;
            }
            this.error.set(describeAiError(err));
            this.settle();
        } finally {
            if (this.controller === controller) this.controller = undefined;
        }
    }

    /** Where a finished, stopped or failed run leaves the bar. */
    private settle(): void {
        this.phase.set(this.output.trim() ? 'review' : 'prompt');
    }

    private abortSignal(): AbortSignal {
        return (this.controller ??= new AbortController()).signal;
    }

    /**
     * Chunks arrive far faster than a person reads, and each one costs a full markdown re-parse
     * of everything so far. Coalescing them keeps the cost proportional to the time the
     * generation takes rather than to how finely the provider happened to slice it.
     */
    private scheduleFlush(): void {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            this.writeThrough();
        }, FLUSH_MS);
    }

    private flushNow(): void {
        this.flushTimer = clearTimer(this.flushTimer);
        this.writeThrough();
    }

    private writeThrough(): void {
        if (!this.stream?.active) return;
        this.stream.write(stripOuterFence(this.output));
        this.reposition();
    }

    private reposition(): void {
        const editor = this.editor();
        const stream = this.stream;
        if (!editor || !stream) return;
        const pos = Math.min(stream.endPos, editor.state.doc.content.size);
        try {
            const coords = editor.view.coordsAtPos(pos);
            this.position.set({
                // Clamped rather than allowed to follow the text off the bottom of the window:
                // a control strip you have to scroll to reach is a control strip you cannot use
                // to stop the thing that is scrolling.
                top: Math.max(8, Math.min(coords.bottom + 8, window.innerHeight - 190)),
                left: Math.max(8, Math.min(coords.left, window.innerWidth - 440)),
            });
        } catch {
            // coordsAtPos throws for a position no longer in the rendered document, which only
            // happens as the surface is being torn down. Keeping the last position is fine.
        }
    }

    private reset(): void {
        this.stream = undefined;
        this.controller = undefined;
        this.output = '';
        this.sourceText = '';
        this.draftPrompt = '';
        this.lastRun = null;
        this.runningLabel.set(null);
        this.error.set(null);
        this.phase.set('closed');
        this.closed.emit();
    }
}

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): undefined {
    if (timer) clearTimeout(timer);
    return undefined;
}
