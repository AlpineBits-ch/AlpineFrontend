import {inject, Injectable, signal} from '@angular/core';
import {SecureStore} from '../platform/ports/secure-store.port';
import {AI_PROVIDER_IDS, AiProviderId, isAiProviderId} from './ai-provider';

const PROVIDER_KEY = 'wiki-ai-provider';
const MODEL_KEY = 'wiki-ai-model';

/**
 * The user's own API keys for their own AI provider accounts.
 *
 * Keys go in {@link SecureStore} - the same store the MLS identity keys use - and never into
 * localStorage. A provider key is a bearer credential for the user's billing account: anything that
 * can read localStorage could spend their money.
 *
 * On desktop that store is the OS keychain. In the browser it is IndexedDB, which is origin-scoped
 * rather than OS-protected, so the guarantee there is weaker: it keeps the key out of the flat
 * `localStorage` namespace and away from anything reading it by name, but a script running on the
 * origin can still reach it. `SecureStore.hardwareBacked` is what says which of the two you have.
 *
 * Nothing here is ever sent to the Echo server. The provider is called directly from this client,
 * and the key's only destination is the provider the user picked.
 *
 * There is deliberately **no read-for-display path**. `getKey` exists to make a request with;
 * the settings UI renders a stored key as a row of dots and reads `configured` to decide whether
 * to draw them. A key that can be shown on screen is a key that can be shoulder-surfed, and there
 * is no reason to look at one you have already saved.
 */
@Injectable({providedIn: 'root'})
export class AiCredentialsService {
    private readonly secureStore = inject(SecureStore);

    /** Which providers currently have a key stored. Drives the settings and connect UI. */
    readonly configured = signal<ReadonlySet<AiProviderId>>(new Set());

    async setKey(provider: AiProviderId, key: string): Promise<void> {
        await this.secureStore.setItem(slot(provider), key);
        this.configured.update(set => new Set(set).add(provider));
    }

    async getKey(provider: AiProviderId): Promise<string | null> {
        try {
            const key = await this.secureStore.getItem(slot(provider));
            return key ? key : null;
        } catch {
            // A locked or unavailable keychain reads as "not configured" rather than throwing
            // into the middle of a draft.
            return null;
        }
    }

    async clearKey(provider: AiProviderId): Promise<void> {
        try {
            await this.secureStore.removeItem(slot(provider));
        } catch {
            // Removing a slot that was never written throws on some backends. The user asked for
            // the key to be gone; a slot that never held one already satisfies that.
        }
        this.configured.update(set => {
            const next = new Set(set);
            next.delete(provider);
            return next;
        });
    }

    /** Refreshes `configured`. The keys themselves are never held in memory between requests. */
    async refresh(): Promise<void> {
        const found = new Set<AiProviderId>();
        for (const id of AI_PROVIDER_IDS) {
            if (await this.getKey(id)) found.add(id);
        }
        this.configured.set(found);
    }

    selectedProvider(): AiProviderId | null {
        try {
            const stored = localStorage.getItem(PROVIDER_KEY);
            return isAiProviderId(stored) ? stored : null;
        } catch {
            return null;
        }
    }

    /** The provider choice and the model name are not secrets - only the key is. */
    selectProvider(provider: AiProviderId, model: string): void {
        try {
            localStorage.setItem(PROVIDER_KEY, provider);
            localStorage.setItem(MODEL_KEY, model);
        } catch {
            // The choice simply does not persist across restarts. Not worth surfacing.
        }
    }

    selectedModel(fallback: string): string {
        try {
            return localStorage.getItem(MODEL_KEY) || fallback;
        } catch {
            return fallback;
        }
    }
}

function slot(provider: AiProviderId): string {
    return `wiki-ai-key-${provider}`;
}
