export type AiProviderId = 'anthropic' | 'openai' | 'gemini';

export const AI_PROVIDER_IDS = ['anthropic', 'openai', 'gemini'] as const;

export interface AiDraftRequest {
    /** What the user asked for. */
    prompt: string;
    title: string;
    /** Current page body; empty for a new page. */
    existingContent: string;
    /** Other page titles in this wiki, so the model can reference real pages. */
    pageTitles: readonly string[];
}

/**
 * Everything the UI needs to describe a provider, with no SDK import behind it.
 *
 * Split from `AiProvider` on purpose: the settings page and the connect panel list all three
 * providers, and pulling in three vendor SDKs to render three labels would put megabytes into the
 * initial bundle for a feature most sessions never touch. Only `loadAiProvider` imports an SDK,
 * and only for the one provider being used.
 */
export interface AiProviderMeta {
    id: AiProviderId;
    label: string;
    defaultModel: string;
    /** Where the user gets a key. Shown next to the key field. */
    keyUrl: string;
}

export const AI_PROVIDER_META: Record<AiProviderId, AiProviderMeta> = {
    anthropic: {
        id: 'anthropic',
        label: 'Claude (Anthropic)',
        defaultModel: 'claude-opus-5',
        keyUrl: 'https://console.anthropic.com/settings/keys',
    },
    openai: {
        id: 'openai',
        label: 'ChatGPT (OpenAI)',
        defaultModel: 'gpt-5',
        keyUrl: 'https://platform.openai.com/api-keys',
    },
    gemini: {
        id: 'gemini',
        label: 'Gemini (Google)',
        defaultModel: 'gemini-2.5-pro',
        keyUrl: 'https://aistudio.google.com/apikey',
    },
};

export interface AiProvider extends AiProviderMeta {
    /** Streams the draft in chunks so the preview fills in as it generates. */
    draft(
        req: AiDraftRequest,
        apiKey: string,
        model: string,
        signal: AbortSignal,
    ): AsyncIterable<string>;
}

export const AI_SYSTEM_PROMPT = [
    'You write documentation pages for a team wiki.',
    'Return the page body as bare GitHub-flavoured Markdown - no code fence around the whole',
    'answer, no preamble, no sign-off. Do not repeat the page title as a heading; it is rendered',
    'separately. Prefer short sections with `##` headings, and keep the tone factual.',
].join(' ');

export function buildDraftPrompt(req: AiDraftRequest): string {
    const parts = [`Page title: ${req.title || 'Untitled'}`, '', `Request: ${req.prompt}`];

    // Both sections are omitted rather than sent empty: an empty "existing content" block
    // reads as "this page is deliberately blank", and an empty page list as "this wiki has
    // no other pages", neither of which is what an absent value means.
    if (req.existingContent.trim()) {
        parts.push('', 'Existing content to revise:', '', req.existingContent);
    }
    if (req.pageTitles.length) {
        parts.push('', `Other pages in this wiki: ${req.pageTitles.join(', ')}`);
    }
    return parts.join('\n');
}

/**
 * Strips a fence the model wrapped the whole answer in despite being asked not to.
 *
 * Only a fence that opens on the first line and closes on the last: a page that legitimately
 * contains a code block still has fences in the middle, and those must survive untouched.
 */
export function stripOuterFence(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.startsWith('```')) return text;

    const lines = trimmed.split('\n');
    // Where the opening fence actually closes, read the way markdown reads it: the first bare
    // ``` line. Only if that is the last line was the whole answer inside one block. A page about
    // shell scripts opens with a fence too, and eating its first and last lines would corrupt it.
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === '```');
    if (close !== lines.length - 1) return text;

    return lines.slice(1, -1).join('\n');
}

export function isAiProviderId(value: unknown): value is AiProviderId {
    return typeof value === 'string' && (AI_PROVIDER_IDS as readonly string[]).includes(value);
}
