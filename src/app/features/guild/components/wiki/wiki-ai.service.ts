import {computed, effect, inject, Injectable, Signal, signal, WritableSignal} from '@angular/core';
import {
    AiAskRequest,
    AiCompleteRequest,
    AiDraftRequest,
    AiMetadata,
    AiMetadataRequest,
    AiProvider,
    AiProviderId,
    AiTransformRequest,
    NoAiProviderError,
} from '../../../../services/ai-provider';
import {AiCredentialsService} from '../../../../services/ai-credentials.service';
import {loadAiProvider} from '../../../../services/ai-providers/registry';

/** Not a secret and not worth a keychain round-trip, so it sits beside the model choice. */
const GHOST_TEXT_KEY = 'wiki-ai-ghost-text';

interface ResolvedProvider {
    provider: AiProvider;
    key: string;
    model: string;
}

/**
 * The wiki's one door to the user's AI provider.
 *
 * Everything about *which* provider, *which* key and *which* model lives here. That resolution
 * used to sit in the AI dialog, which was fine while the dialog was the only caller; it now has
 * five - draft, transform, ask, ghost text and metadata - and five copies of "selected provider,
 * unless it has no key, in which case any provider that does" would drift apart within a release.
 *
 * Keys are fetched per request and never held: `AiCredentialsService` keeps them in the OS
 * keychain, and a service that cached one would put a bearer credential for the user's billing
 * account into a long-lived object for no gain.
 */
@Injectable({providedIn: 'root'})
export class WikiAiService {
    private readonly credentials = inject(AiCredentialsService);

    /** Which provider a request would go to, or null when nothing is connected. */
    readonly activeProvider: Signal<AiProviderId | null> = computed(() => {
        const configured = this.credentials.configured();
        const selected = this.credentials.selectedProvider();
        if (selected && configured.has(selected)) return selected;
        // A key saved without ever visiting settings still counts: the question is whether a
        // request can be made, not whether a preference was recorded.
        return [...configured][0] ?? null;
    });

    /** True when some provider is connected and a request could actually be made. */
    readonly available: Signal<boolean> = computed(() => this.activeProvider() !== null);

    /**
     * Off by default. Ghost text spends the user's own API credit on every pause in their typing,
     * which is not a cost anyone would consent to by not being asked.
     */
    readonly ghostTextEnabled: WritableSignal<boolean> = signal(readGhostTextPreference());

    constructor() {
        // `configured` starts empty, so without this every caller would see `available()` false
        // until something else happened to refresh it. It is a signal, so the UI corrects itself
        // when the keychain answers.
        void this.credentials.refresh();

        effect(() => {
            const enabled = this.ghostTextEnabled();
            try {
                localStorage.setItem(GHOST_TEXT_KEY, enabled ? '1' : '0');
            } catch {
                // The preference simply does not survive a restart. Not worth telling anyone.
            }
        });
    }

    /** Re-reads the keychain. Call after the connect flow so `available` catches up. */
    async refresh(): Promise<void> {
        await this.credentials.refresh();
    }

    draft(req: AiDraftRequest, signal: AbortSignal): AsyncIterable<string> {
        this.assertAvailable();
        return this.stream((provider, key, model) => provider.draft(req, key, model, signal));
    }

    transform(req: AiTransformRequest, signal: AbortSignal): AsyncIterable<string> {
        this.assertAvailable();
        return this.stream((provider, key, model) => provider.transform(req, key, model, signal));
    }

    ask(req: AiAskRequest, signal: AbortSignal): AsyncIterable<string> {
        this.assertAvailable();
        return this.stream((provider, key, model) => provider.ask(req, key, model, signal));
    }

    async complete(req: AiCompleteRequest, signal: AbortSignal): Promise<string> {
        const {provider, key, model} = await this.resolve();
        return provider.complete(req, key, model, signal);
    }

    async suggestMetadata(req: AiMetadataRequest, signal: AbortSignal): Promise<AiMetadata> {
        const {provider, key, model} = await this.resolve();
        return provider.suggestMetadata(req, key, model, signal);
    }

    /**
     * Throws before the generator is built, not on its first `next()`.
     *
     * The streaming methods return synchronously, so without this a caller that never iterates -
     * or that only iterates inside a `try` around the render loop - would get "nothing connected"
     * somewhere far from where it asked. The async path checks again anyway, because a key can
     * disappear between the check and the request.
     */
    private assertAvailable(): void {
        if (!this.available()) throw new NoAiProviderError();
    }

    private async* stream(
        call: (provider: AiProvider, key: string, model: string) => AsyncIterable<string>,
    ): AsyncIterable<string> {
        const {provider, key, model} = await this.resolve();
        yield* call(provider, key, model);
    }

    private async resolve(): Promise<ResolvedProvider> {
        const id = this.activeProvider();
        if (!id) throw new NoAiProviderError();

        const key = await this.credentials.getKey(id);
        if (!key) {
            // `configured` said yes and the keychain said no - the entry has gone from under us.
            // Correcting it here is what makes the UI offer the connect flow next time.
            await this.credentials.refresh();
            throw new NoAiProviderError();
        }

        const provider = await loadAiProvider(id);
        return {provider, key, model: this.credentials.selectedModel(provider.defaultModel)};
    }
}

function readGhostTextPreference(): boolean {
    try {
        return localStorage.getItem(GHOST_TEXT_KEY) === '1';
    } catch {
        return false;
    }
}
