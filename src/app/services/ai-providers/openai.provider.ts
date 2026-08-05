import OpenAI from 'openai';
import {
    AI_PROVIDER_META,
    AI_SYSTEM_PROMPT,
    AiDraftRequest,
    AiProvider,
    buildDraftPrompt,
} from '../ai-provider';

export const openaiProvider: AiProvider = {
    ...AI_PROVIDER_META.openai,

    async* draft(req: AiDraftRequest, apiKey: string, model: string, signal: AbortSignal) {
        // See the note in anthropic.provider.ts: the user's own key, on the user's own machine.
        const client = new OpenAI({apiKey, dangerouslyAllowBrowser: true});

        const stream = await client.chat.completions.create({
            model,
            stream: true,
            messages: [
                {role: 'system', content: AI_SYSTEM_PROMPT},
                {role: 'user', content: buildDraftPrompt(req)},
            ],
        }, {signal});

        for await (const chunk of stream) {
            const text = chunk.choices[0]?.delta?.content;
            if (text) yield text;
        }
    },
};
