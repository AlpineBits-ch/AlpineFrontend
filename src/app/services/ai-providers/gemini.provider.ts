import {GenerateContentConfig, GoogleGenAI} from '@google/genai';
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
 * Flash-lite with thinking off is the fastest thing this family offers, and the default the user
 * picked for drafting - Pro - cannot turn thinking off at all, so it can never fit a typing pause.
 */
const FAST_COMPLETE_MODEL = 'gemini-2.5-flash-lite';

export const geminiProvider: AiProvider = {
    ...AI_PROVIDER_META.gemini,

    async* draft(req: AiDraftRequest, apiKey: string, model: string, signal: AbortSignal) {
        yield* streamText(apiKey, model, AI_SYSTEM_PROMPT, buildDraftPrompt(req), signal);
    },

    async* transform(req: AiTransformRequest, apiKey: string, model: string, signal: AbortSignal) {
        yield* streamText(
            apiKey, model, AI_TRANSFORM_SYSTEM_PROMPT, buildTransformPrompt(req), signal,
        );
    },

    async* ask(req: AiAskRequest, apiKey: string, model: string, signal: AbortSignal) {
        yield* streamText(apiKey, model, AI_ASK_SYSTEM_PROMPT, buildAskPrompt(req), signal);
    },

    async complete(req: AiCompleteRequest, apiKey: string, model: string, signal: AbortSignal) {
        if (shouldSkipCompletion(req)) return '';

        const client = new GoogleGenAI({apiKey});
        const fast = pickFastModel(model, FAST_COMPLETE_MODEL);

        const response = await client.models.generateContent({
            model: fast,
            contents: buildCompletePrompt(req),
            config: {
                systemInstruction: AI_COMPLETE_SYSTEM_PROMPT,
                abortSignal: signal,
                maxOutputTokens: 96,
                stopSequences: ['\n\n'],
                ...noThinking(fast),
            },
        });

        return sanitizeCompletion(req.before, response.text ?? '');
    },

    async suggestMetadata(
        req: AiMetadataRequest,
        apiKey: string,
        model: string,
        signal: AbortSignal,
    ): Promise<AiMetadata> {
        const client = new GoogleGenAI({apiKey});

        const response = await client.models.generateContent({
            model,
            contents: buildMetadataPrompt(req),
            config: {
                systemInstruction: AI_METADATA_SYSTEM_PROMPT,
                abortSignal: signal,
                // `responseJsonSchema` rather than `responseSchema` so the same schema object
                // serves all three providers; it takes plain JSON Schema, and the mime type is
                // required alongside it.
                responseMimeType: 'application/json',
                responseJsonSchema: AI_METADATA_SCHEMA,
            },
        });

        return parseAiMetadata(response.text ?? '');
    },
};

async function* streamText(
    apiKey: string,
    model: string,
    systemInstruction: string,
    contents: string,
    signal: AbortSignal,
): AsyncIterable<string> {
    const client = new GoogleGenAI({apiKey});

    // This SDK takes the abort signal in the request config rather than as a second argument,
    // which is why the shape here does not match the other two providers.
    const stream = await client.models.generateContentStream({
        model,
        contents,
        config: {systemInstruction, abortSignal: signal},
    });

    for await (const chunk of stream) {
        const text = chunk.text;
        if (text) yield text;
    }
}

/**
 * Turns thinking off, where the model understands being asked.
 *
 * `thinkingBudget: 0` is the 2.5 family's switch and the newer families reject it, so it is sent
 * only where it is known good. Everywhere else the request simply keeps the model's default -
 * slower than we would like, but a working suggestion beats a 400.
 */
function noThinking(model: string): Pick<GenerateContentConfig, 'thinkingConfig'> | Record<string, never> {
    return /^gemini-2\./i.test(model) ? {thinkingConfig: {thinkingBudget: 0}} : {};
}
