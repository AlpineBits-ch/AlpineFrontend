import {GoogleGenAI} from '@google/genai';
import {
    AI_PROVIDER_META,
    AI_SYSTEM_PROMPT,
    AiDraftRequest,
    AiProvider,
    buildDraftPrompt,
} from '../ai-provider';

export const geminiProvider: AiProvider = {
    ...AI_PROVIDER_META.gemini,

    async* draft(req: AiDraftRequest, apiKey: string, model: string, signal: AbortSignal) {
        const client = new GoogleGenAI({apiKey});

        // This SDK takes the abort signal in the request config rather than as a second argument,
        // which is why the shape here does not match the other two providers.
        const stream = await client.models.generateContentStream({
            model,
            contents: buildDraftPrompt(req),
            config: {systemInstruction: AI_SYSTEM_PROMPT, abortSignal: signal},
        });

        for await (const chunk of stream) {
            const text = chunk.text;
            if (text) yield text;
        }
    },
};
