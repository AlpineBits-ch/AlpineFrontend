import {Component, effect, ElementRef, inject, input, output, signal, viewChild} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule} from '@ngx-translate/core';
import {AiAskSource} from '../../../../../services/ai-provider';
import {AiConnectFormComponent} from '../../../../../shared/ai-connect-form/ai-connect-form.component';
import {WikiAiService} from '../wiki-ai.service';
import {DomSanitizer, SafeHtml} from '@angular/platform-browser';
import {AnswerSegment, buildAskQuestion, splitAnswer} from './wiki-ai-answer';
import {renderWikiAnswer} from '../wiki.utils';
import {parseWikiHref} from '../wiki-links';
import {describeAiError, isMissingProvider, rankAskSources} from './wiki-ai-shared';

interface AskTurn {
    question: string;
    answer: string;
    segments: AnswerSegment[];
    /** A provider's own words, shown verbatim. */
    error: string | null;
    /** How many pages this answer was allowed to look at. */
    sourceCount: number;
    /** Whether the index was complete when it was asked. */
    complete: boolean;
}

/**
 * Questions answered from the wiki's own pages, with the citations as ordinary wiki links.
 *
 * The rule this surface exists to keep is that it never answers from a partial index without
 * saying so. Page bodies arrive through {@link WikiContentCacheService}, which fills lazily as
 * pages are opened; asking "what is our on-call policy" against the four pages you happen to have
 * visited would produce a confident answer about the wrong thing. So an unwarmed cache is asked to
 * warm, the progress is shown, and the question waits - unless the warm has failed outright, in
 * which case answering from what did load is better than a feature that is permanently broken, and
 * the answer says which it was.
 */
@Component({
    selector: 'app-wiki-ai-ask',
    imports: [FormsModule, TranslateModule, AiConnectFormComponent],
    templateUrl: './wiki-ai-ask.component.html',
})
export class WikiAiAskComponent {
    readonly open = input(false);
    /** Candidate pages with bodies, supplied by the integrator from the content cache. */
    readonly sources = input<readonly AiAskSource[]>([]);
    /** `WikiContentCacheService.warmed()` - true only when every body is present. */
    readonly sourcesComplete = input(false);
    /** `WikiContentCacheService.warming()`. */
    readonly sourcesLoading = input(false);
    /** `WikiContentCacheService.failed()`. */
    readonly sourcesFailed = input(false);

    readonly closed = output<void>();
    /** Asks the integrator to call `WikiContentCacheService.warm(guildId)`. */
    readonly warmRequested = output<void>();
    readonly pageSelected = output<string>();

    protected readonly ai = inject(WikiAiService);
    private readonly sanitizer = inject(DomSanitizer);

    /**
     * The answer as rendered markdown rather than as raw text.
     *
     * Answers come back as markdown - headings, lists, bold, code - and were being printed
     * verbatim, so `##` and `**` showed up on screen. Citations survive because the renderer
     * allows the `wiki:` scheme; clicks on them are delegated in `onAnswerClick`.
     */
    protected renderAnswer(markdown: string): SafeHtml {
        return renderWikiAnswer(markdown, this.sanitizer);
    }

    /**
     * Citations are ordinary anchors inside rendered HTML, so there is nothing to bind a click to
     * per link. One delegated handler on the container turns a `wiki:` href into navigation and
     * leaves every other link alone.
     */
    protected onAnswerClick(event: MouseEvent): void {
        const anchor = (event.target as HTMLElement).closest('a');
        const pageId = anchor && parseWikiHref(anchor.getAttribute('href'));
        if (!pageId) return;
        event.preventDefault();
        this.openPage(pageId);
    }
    protected readonly turns = signal<AskTurn[]>([]);
    protected readonly running = signal(false);
    protected readonly connecting = signal(false);
    protected question = '';

    private readonly questionInput = viewChild<ElementRef<HTMLInputElement>>('questionInput');

    private controller?: AbortController;

    constructor() {
        // The panel opens on a keystroke, so the caret has to be in the field the keystroke was
        // heading for.
        effect(() => {
            const input = this.questionInput();
            if (this.open() && input) input.nativeElement.focus();
        });

        effect(() => {
            if (!this.open()) {
                this.stop();
                this.connecting.set(false);
                return;
            }
            void this.ai.refresh();
            // Asked for on open rather than on send: the warm is one request and takes a moment,
            // and the moment to spend it is while the user is still typing their question.
            if (!this.sourcesComplete() && !this.sourcesLoading() && !this.sourcesFailed()) {
                this.warmRequested.emit();
            }
        });
    }

    /** True while the index is still filling, which is the one state that blocks a question. */
    protected blocked(): boolean {
        return !this.sourcesComplete() && !this.sourcesFailed();
    }

    protected async send(): Promise<void> {
        const question = this.question.trim();
        if (!question || this.running() || this.blocked()) return;

        const ranked = rankAskSources(this.sources(), question);
        const history = this.turns().map(turn => ({question: turn.question, answer: turn.answer}));
        const turn: AskTurn = {
            question,
            answer: '',
            segments: [],
            error: null,
            sourceCount: ranked.length,
            complete: this.sourcesComplete(),
        };
        this.turns.update(turns => [...turns, turn]);
        this.question = '';

        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        this.running.set(true);

        try {
            const stream = this.ai.ask(
                {
                    // Earlier turns ride along inside the question: the request shape carries no
                    // history, and "what about the second one?" is meaningless without it.
                    question: buildAskQuestion(history, question),
                    sources: ranked,
                },
                controller.signal,
            );
            for await (const chunk of stream) {
                if (controller.signal.aborted) break;
                this.appendToLast(chunk);
            }
        } catch (err) {
            if (controller.signal.aborted) return;
            if (isMissingProvider(err)) {
                this.connecting.set(true);
                // The question is put back in the field rather than left as an empty turn: the
                // user has not asked anything yet as far as the provider is concerned.
                this.turns.update(turns => turns.slice(0, -1));
                this.question = question;
                return;
            }
            this.failLast(describeAiError(err));
        } finally {
            if (this.controller === controller) this.controller = undefined;
            this.running.set(false);
        }
    }

    protected stop(): void {
        this.controller?.abort();
        this.controller = undefined;
        this.running.set(false);
    }

    protected clear(): void {
        this.stop();
        this.turns.set([]);
    }

    protected openPage(pageId: string): void {
        this.pageSelected.emit(pageId);
        this.closed.emit();
    }

    protected onConnected(): void {
        this.connecting.set(false);
        void this.ai.refresh();
    }

    protected onKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.preventDefault();
            this.closed.emit();
        }
    }

    private appendToLast(chunk: string): void {
        this.turns.update(turns => {
            const last = turns.at(-1);
            if (!last) return turns;
            const answer = last.answer + chunk;
            return [...turns.slice(0, -1), {...last, answer, segments: splitAnswer(answer)}];
        });
    }

    private failLast(message: string): void {
        this.turns.update(turns => {
            const last = turns.at(-1);
            if (!last) return turns;
            return [...turns.slice(0, -1), {...last, error: message}];
        });
    }
}
