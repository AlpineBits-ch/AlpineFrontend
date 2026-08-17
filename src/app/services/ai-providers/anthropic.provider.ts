import Anthropic from '@anthropic-ai/sdk';
import {
    AI_ASK_SYSTEM_PROMPT,
    AI_COMPLETE_SYSTEM_PROMPT,
    AI_METADATA_SCHEMA,
    AI_METADATA_SYSTEM_PROMPT,
    AI_PROVIDER_META,
    AI_SYSTEM_PROMPT,
    AI_TRANSFORM_SYSTEM_PROMPT,
    AiAskRequest,
    AiCompleteRequest,
    AiDraftRequest,
    AiMetadata,
    AiMetadataRequest,
    AiProvider,
    AiTransformRequest,
    buildAskPrompt,
    buildCompletePrompt,
    buildDraftPrompt,
    buildMetadataPrompt,
    buildTransformPrompt,
    parseAiMetadata,
    pickFastModel,
    sanitizeCompletion,
    shouldSkipCompletion,
} from '../ai-provider';

/**
 * The model ghost text runs on when the user has not already picked something small.
 *
 * Haiku is the only tier in this family whose time-to-first-token fits inside a typing pause;
 * a suggestion that lands after the author has already typed the next word is worse than none.
 */
const FAST_COMPLETE_MODEL = 'claude-haiku-4-5';

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
        yield* streamText(client, {
            model,
            max_tokens: 16000,
            system: AI_SYSTEM_PROMPT,
            messages: [{role: 'user', content: buildDraftPrompt(req)}],
        }, signal);
    },

    async* transform(req: AiTransformRequest, apiKey: string, model: string, signal: AbortSignal) {
        const client = new Anthropic({apiKey, dangerouslyAllowBrowser: true});

        // Sized against the passage rather than fixed: a rewrite is about as long as its input,
        // and an "expand" is a few times longer. The floor covers a one-line selection, the
        // ceiling stops a runaway from billing the user for a whole book.
        const budget = Math.min(16000, Math.max(1024, Math.ceil(req.text.length / 2) + 512));

        yield* streamText(client, {
            model,
            max_tokens: budget,
            system: AI_TRANSFORM_SYSTEM_PROMPT,
            messages: [{role: 'user', content: buildTransformPrompt(req)}],
        }, signal);
    },

    async* ask(req: AiAskRequest, apiKey: string, model: string, signal: AbortSignal) {
        const client = new Anthropic({apiKey, dangerouslyAllowBrowser: true});

        yield* streamText(client, {
            model,
            max_tokens: 4000,
            system: AI_ASK_SYSTEM_PROMPT,
            messages: [{role: 'user', content: buildAskPrompt(req)}],
        }, signal);
    },

    async complete(req: AiCompleteRequest, apiKey: string, model: string, signal: AbortSignal) {
        if (shouldSkipCompletion(req)) return '';

        const client = new Anthropic({apiKey, dangerouslyAllowBrowser: true});
        const message = await client.messages.create({
            model: pickFastModel(model, FAST_COMPLETE_MODEL),
            // Two caps, because the prompt alone does not hold: max_tokens bounds the bill, and
            // the stop sequence ends the suggestion the moment the model starts a new paragraph.
            max_tokens: 96,
            stop_sequences: ['\n\n'],
            system: AI_COMPLETE_SYSTEM_PROMPT,
            messages: [{role: 'user', content: buildCompletePrompt(req)}],
        }, {signal});

        return sanitizeCompletion(req.before, textOf(message));
    },

    async suggestMetadata(
        req: AiMetadataRequest,
        apiKey: string,
        model: string,
        signal: AbortSignal,
    ): Promise<AiMetadata> {
        const client = new Anthropic({apiKey, dangerouslyAllowBrowser: true});

        const message = await client.messages.create({
            model,
            max_tokens: 1024,
            system: AI_METADATA_SYSTEM_PROMPT,
            // Structured output rather than "please reply with JSON": the schema is enforced
            // server-side, so `parseAiMetadata` is a guard against the unexpected rather than the
            // thing standing between the user and a page tagged with an apology.
            output_config: {format: {type: 'json_schema', schema: AI_METADATA_SCHEMA}},
            messages: [{role: 'user', content: buildMetadataPrompt(req)}],
        }, {signal});

        return parseAiMetadata(textOf(message));
    },
};

/**
 * Streams the text deltas of one message, and fails loudly on a refusal.
 *
 * A refusal comes back as an ordinary 200 with no usable text. Saying so is more honest than
 * leaving the caller with a mysteriously empty result.
 */
async function* streamText(
    client: Anthropic,
    params: Anthropic.MessageStreamParams,
    signal: AbortSignal,
): AsyncIterable<string> {
    const stream = client.messages.stream(params, {signal});

    for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            yield event.delta.text;
        }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
        throw new Error('Claude declined this request.');
    }
}

function textOf(message: Anthropic.Message): string {
    return message.content
        .flatMap(block => (block.type === 'text' ? [block.text] : []))
        .join('');
}
