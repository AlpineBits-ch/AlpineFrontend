import {Component, effect, inject, input, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {AI_PROVIDER_META, AiProviderId, stripOuterFence} from '../../../../../services/ai-provider';
import {AiCredentialsService} from '../../../../../services/ai-credentials.service';
import {loadAiProvider} from '../../../../../services/ai-providers/registry';
import {AiConnectFormComponent} from '../../../../../shared/ai-connect-form/ai-connect-form.component';

/**
 * Drafts a wiki page from a prompt, using the user's own provider account.
 *
 * The result never goes to the server from here. It is handed back to the article, which applies
 * it as an ordinary editor transaction - undoable, autosaved as a draft, saved only when the user
 * presses Save like any other edit.
 */
@Component({
    selector: 'app-wiki-ai-dialog',
    imports: [FormsModule, Button, Dialog, PrimeTemplate, TranslateModule, AiConnectFormComponent],
    templateUrl: './wiki-ai-dialog.component.html',
})
export class WikiAiDialogComponent {
    readonly open = input(false);
    readonly pageTitle = input('');
    readonly existingContent = input('');
    readonly pageTitles = input<readonly string[]>([]);

    readonly closed = output<void>();
    readonly insert = output<string>();
    readonly replace = output<string>();

    protected readonly credentials = inject(AiCredentialsService);
    protected readonly meta = AI_PROVIDER_META;

    protected prompt = '';
    protected readonly draft = signal('');
    protected readonly running = signal(false);
    /** A translation key when the message is ours, a raw sentence when it came from a provider. */
    protected readonly error = signal<string | null>(null);
    protected readonly errorIsKey = signal(true);
    /** Flipped when the user asks to connect, and back once a key lands. */
    protected readonly connecting = signal(false);

    private controller?: AbortController;

    constructor() {
        // Reopening must not show the previous answer, and must not leave a stream running behind
        // a closed dialog.
        effect(() => {
            if (this.open()) {
                void this.credentials.refresh();
            } else {
                this.abort();
                this.draft.set('');
                this.error.set(null);
                this.connecting.set(false);
            }
        });
    }

    /** Which provider a Generate would use, or null when nothing is connected yet. */
    protected activeProvider(): AiProviderId | null {
        const selected = this.credentials.selectedProvider();
        if (selected && this.credentials.configured().has(selected)) return selected;
        // A key saved without ever visiting settings still counts: the point is whether a
        // request can be made, not whether a preference was recorded.
        return [...this.credentials.configured()][0] ?? null;
    }

    protected async generate(): Promise<void> {
        const providerId = this.activeProvider();
        if (!providerId) {
            this.connecting.set(true);
            return;
        }
        const request = this.prompt.trim();
        if (!request || this.running()) return;

        const key = await this.credentials.getKey(providerId);
        if (!key) {
            // Configured said yes and the keychain said no - the entry is gone underneath us.
            this.connecting.set(true);
            await this.credentials.refresh();
            return;
        }

        this.abort();
        this.controller = new AbortController();
        this.running.set(true);
        this.error.set(null);
        this.draft.set('');

        try {
            const provider = await loadAiProvider(providerId);
            const model = this.credentials.selectedModel(provider.defaultModel);
            const stream = provider.draft(
                {
                    prompt: request,
                    title: this.pageTitle(),
                    existingContent: this.existingContent(),
                    pageTitles: this.pageTitles(),
                },
                key,
                model,
                this.controller.signal,
            );
            for await (const chunk of stream) {
                this.draft.update(text => text + chunk);
            }
        } catch (err) {
            // An abort is the user pressing Stop, not a failure worth a red message.
            if (!this.controller?.signal.aborted) {
                this.errorIsKey.set(false);
                this.error.set(describe(err));
            }
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
        this.error.set(null);
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

/**
 * Provider errors are the only thing here worth showing verbatim - "401 invalid x-api-key" tells
 * the user exactly what to fix, and no wording we could substitute would be more useful.
 */
function describe(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return String(err);
}
