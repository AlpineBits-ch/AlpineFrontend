import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    output,
    signal,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {AI_PROVIDER_META, stripOuterFence} from '../../../../../services/ai-provider';
import {AiConnectFormComponent} from '../../../../../shared/ai-connect-form/ai-connect-form.component';
import {WikiAiService} from '../wiki-ai.service';
import {describeAiError, isMissingProvider} from './wiki-ai-shared';

/**
 * Drafts a whole wiki page from a prompt.
 *
 * It is no longer the only way to reach AI in the wiki - the inline bar, the bubble menu and the
 * ask panel all exist now - and it deliberately no longer tries to be. What is left is the one
 * job that is genuinely dialog-shaped: describing a page that does not exist yet, in a sentence
 * or two, before there is any document to stand next to.
 *
 * Its default answer to "Generate" is therefore to hand the prompt to the inline bar and get out
 * of the way, so the page is written in the page. The preview here remains for the case the
 * inline bar cannot serve - a page being read rather than edited - and for anyone who would
 * rather see the markdown before it lands.
 *
 * Nothing here goes to the server. The result is applied as an ordinary editor transaction:
 * undoable, autosaved as a draft, saved only when the user presses Save like any other edit.
 */
@Component({
    selector: 'app-wiki-ai-dialog',
    imports: [FormsModule, Button, Dialog, PrimeTemplate, TranslateModule, AiConnectFormComponent],
    templateUrl: './wiki-ai-dialog.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WikiAiDialogComponent {
    readonly open = input(false);
    readonly pageTitle = input('');
    readonly existingContent = input('');
    readonly pageTitles = input<readonly string[]>([]);
    /**
     * Whether the article can take a stream right now - in practice, whether it is in edit mode.
     * When it can, writing into the page is the primary action and this dialog is just the prompt.
     */
    readonly canStreamInPlace = input(false);

    readonly closed = output<void>();
    readonly insert = output<string>();
    readonly replace = output<string>();
    /** The prompt, for the article's inline AI bar to stream into the document. */
    readonly streamRequest = output<string>();

    protected readonly ai = inject(WikiAiService);

    protected prompt = '';
    protected readonly draft = signal('');
    protected readonly running = signal(false);
    /** A provider's own words. Never one of ours - see {@link describeAiError}. */
    protected readonly error = signal<string | null>(null);
    /** Flipped when the user asks to connect, and back once a key lands. */
    protected readonly connecting = signal(false);

    protected readonly providerLabel = computed(() => {
        const id = this.ai.activeProvider();
        return id ? AI_PROVIDER_META[id].label : '';
    });

    private controller?: AbortController;

    constructor() {
        // Reopening must not show the previous answer, and must not leave a stream running behind
        // a closed dialog.
        effect(() => {
            if (this.open()) {
                void this.ai.refresh();
            } else {
                this.abort();
                this.draft.set('');
                this.error.set(null);
                this.connecting.set(false);
            }
        });
    }

    /**
     * Hands the prompt to the inline bar. The dialog closes immediately: what happens next is
     * meant to be watched in the page, not in a modal on top of it.
     */
    protected writeIntoPage(): void {
        const request = this.prompt.trim();
        if (!request) return;
        this.streamRequest.emit(request);
        this.prompt = '';
        this.closed.emit();
    }

    protected async generate(): Promise<void> {
        const request = this.prompt.trim();
        if (!request || this.running()) return;

        this.abort();
        this.controller = new AbortController();
        const controller = this.controller;
        this.running.set(true);
        this.error.set(null);
        this.draft.set('');

        try {
            const stream = this.ai.draft(
                {
                    prompt: request,
                    title: this.pageTitle(),
                    existingContent: this.existingContent(),
                    pageTitles: this.pageTitles(),
                },
                controller.signal,
            );
            for await (const chunk of stream) {
                this.draft.update(text => text + chunk);
            }
        } catch (err) {
            // An abort is the user pressing Stop, not a failure worth a red message.
            if (controller.signal.aborted) return;
            // Not pre-checked before the request: `available()` can be true and the key gone from
            // the keychain underneath it, and the service reports both the same way.
            if (isMissingProvider(err)) {
                this.connecting.set(true);
                return;
            }
            this.error.set(describeAiError(err));
        } finally {
            this.running.set(false);
        }
    }

    protected stop(): void {
        this.abort();
        this.running.set(false);
    }

    protected onConnected(): void {
        this.connecting.set(false);
        void this.ai.refresh();
    }

    protected applyInsert(): void {
        this.insert.emit(stripOuterFence(this.draft()));
        this.closed.emit();
    }

    protected applyReplace(): void {
        this.replace.emit(stripOuterFence(this.draft()));
        this.closed.emit();
    }

    private abort(): void {
        this.controller?.abort();
        this.controller = undefined;
    }
}
