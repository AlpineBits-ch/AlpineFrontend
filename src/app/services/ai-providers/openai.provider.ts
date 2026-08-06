import OpenAI from 'openai';
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
 * The nano tier is the only one here that answers inside a typing pause; the flagship the user
 * picked for drafting spends seconds thinking before its first token, which is the whole budget.
 */
const FAST_COMPLETE_MODEL = 'gpt-5-nano';

export const openaiProvider: AiProvider = {
    ...AI_PROVIDER_META.openai,

    async* draft(req: AiDraftRequest, apiKey: string, model: string, signal: AbortSignal) {
        // See the note in anthropic.provider.ts: the user's own key, on the user's own machine.
        const client = new OpenAI({apiKey, dangerouslyAllowBrowser: true});

        yield* streamChat(client, model, AI_SYSTEM_PROMPT, buildDraftPrompt(req), signal);
    },

    async* transform(req: AiTransformRequest, apiKey: string, model: string, signal: AbortSignal) {
        const client = new OpenAI({apiKey, dangerouslyAllowBrowser: true});

        yield* streamChat(
            client, model, AI_TRANSFORM_SYSTEM_PROMPT, buildTransformPrompt(req), signal,
        );
    },

    async* ask(req: AiAskRequest, apiKey: string, model: string, signal: AbortSignal) {
        const client = new OpenAI({apiKey, dangerouslyAllowBrowser: true});

        yield* streamChat(client, model, AI_ASK_SYSTEM_PROMPT, buildAskPrompt(req), signal);
    },

    async complete(req: AiCompleteRequest, apiKey: string, model: string, signal: AbortSignal) {
        if (shouldSkipCompletion(req)) return '';

        const client = new OpenAI({apiKey, dangerouslyAllowBrowser: true});
        const fast = pickFastModel(model, FAST_COMPLETE_MODEL);

        const completion = await client.chat.completions.create({
            model: fast,
            // Generous for a one-sentence answer because on a reasoning model this budget covers
            // the hidden reasoning tokens too - set it to the length of the suggestion and the
            // model can spend the entire allowance thinking and return nothing. `reasoning_effort`
            // keeps that short, and `sanitizeCompletion` enforces the length the user actually
            // sees. `stop` is not used: the API rejects it on the newer reasoning models.
            max_completion_tokens: 256,
            ...(isReasoningModel(fast) ? {reasoning_effort: 'minimal' as const} : {}),
            messages: [
                {role: 'system', content: AI_COMPLETE_SYSTEM_PROMPT},
                {role: 'user', content: buildCompletePrompt(req)},
            ],
        }, {signal});

        return sanitizeCompletion(req.before, completion.choices[0]?.message?.content ?? '');
    },

    async suggestMetadata(
        req: AiMetadataRequest,
        apiKey: string,
        model: string,
        signal: AbortSignal,
    ): Promise<AiMetadata> {
        const client = new OpenAI({apiKey, dangerouslyAllowBrowser: true});

        const completion = await client.chat.completions.create({
            model,
            // Strict structured output, not `json_object`: the schema is enforced server-side, so
            // a missing field is a bug on our side rather than a coin flip on the model's.
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'wiki_page_metadata',
                    strict: true,
                    schema: AI_METADATA_SCHEMA,
                },
            },
            messages: [
                {role: 'system', content: AI_METADATA_SYSTEM_PROMPT},
                {role: 'user', content: buildMetadataPrompt(req)},
            ],
        }, {signal});

        // A refusal comes back in its own field with `content` null, which would otherwise reach
        // the parser as "no JSON object" and read like our bug.
        const refusal = completion.choices[0]?.message?.refusal;
        if (refusal) throw new Error(refusal);

        return parseAiMetadata(completion.choices[0]?.message?.content ?? '');
    },
};

/**
 * Streams one system+user exchange.
 *
 * No `max_completion_tokens` on the streaming ops on purpose: on a reasoning model that ceiling
 * covers hidden reasoning as well as the answer, so a cap generous enough to be safe is not a cap,
 * and a cap tight enough to matter truncates the page mid-sentence. Length is steered by the
 * prompt here, and the user's own budget bounds the rest.
 */
async function* streamChat(
    client: OpenAI,
    model: string,
    system: string,
    user: string,
    signal: AbortSignal,
): AsyncIterable<string> {
    const stream = await client.chat.completions.create({
        model,
        stream: true,
        messages: [
            {role: 'system', content: system},
            {role: 'user', content: user},
        ],
    }, {signal});

    for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content;
        if (text) yield text;
    }
}

/** Whether `reasoning_effort` is a parameter this model accepts - older models 400 on it. */
function isReasoningModel(model: string): boolean {
    return /^(gpt-5|o[1-9])/i.test(model);
}
