import {AiProvider, AiProviderId} from '../ai-provider';

/**
 * Loads the one provider actually being used.
 *
 * Dynamic imports, not a static map: each SDK is hundreds of kilobytes, and a session that never
 * drafts a page should not pay for any of them. `AI_PROVIDER_META` covers everything the UI needs
 * to *describe* the providers without loading one.
 */
export function loadAiProvider(id: AiProviderId): Promise<AiProvider> {
    switch (id) {
        case 'anthropic':
            return import('./anthropic.provider').then(m => m.anthropicProvider);
        case 'openai':
            return import('./openai.provider').then(m => m.openaiProvider);
        case 'gemini':
            return import('./gemini.provider').then(m => m.geminiProvider);
    }
}
