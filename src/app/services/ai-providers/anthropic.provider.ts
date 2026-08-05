import Anthropic from '@anthropic-ai/sdk';
import {
    AI_PROVIDER_META,
    AI_SYSTEM_PROMPT,
    AiDraftRequest,
    AiProvider,
    buildDraftPrompt,
} from '../ai-provider';

export const anthropicProvider: AiProvider = {
    ...AI_PROVIDER_META.anthropic,

    async* draft(req: AiDraftRequest, apiKey: string, model: string, signal: AbortSignal) {
        // The key is the user's own, held in their OS keychain and used from their own machine.
        // The reason this flag exists - a server-side key leaking to every visitor of a web page -
        // does not apply to a desktop app calling the provider on the user's behalf.
        const client = new Anthropic({apiKey, dangerouslyAllowBrowser: true});

        // Streaming rather than create(): a page-length answer at this token budget is well past
        // the point where a single non-streaming request risks an HTTP timeout, and the preview
        // fills in as it generates instead of sitting blank.
        const stream = client.messages.stream({
            model,
            max_tokens: 16000,
            system: AI_SYSTEM_PROMPT,
            messages: [{role: 'user', content: buildDraftPrompt(req)}],
        }, {signal});

        for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                yield event.delta.text;
            }
        }

        // A refusal comes back as an ordinary 200 with no usable text. Saying so is more honest
        // than leaving the preview mysteriously empty.
        const final = await stream.finalMessage();
        if (final.stop_reason === 'refusal') {
            throw new Error('Claude declined this request.');
        }
    },
};
