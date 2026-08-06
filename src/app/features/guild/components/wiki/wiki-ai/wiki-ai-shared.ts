import {Editor, JSONContent} from '@tiptap/core';
// Side-effect import: `editor.markdown` reaches `Editor` through this package's module
// augmentation, so a compilation that does not otherwise pull it in - a spec whose import graph
// never reaches `wiki-extensions.ts` - would not know the property exists.
import '@tiptap/markdown';
import {AiAskSource, AiTransformOp, NoAiProviderError} from '../../../../../services/ai-provider';

/**
 * Small pieces every AI surface in the wiki needs.
 *
 * They live here rather than in one of the components because the inline bar, the bubble menu,
 * the ask panel and the draft dialog all have to answer the same three questions the same way -
 * is a provider connected, what did the provider say went wrong, and what markdown does this
 * selection actually contain.
 */

/** What a bubble-menu AI item asks the inline bar to do. */
export interface WikiAiTransformAction {
    op: AiTransformOp;
    /** A tone name, a target language, or the user's own words. */
    instruction?: string;
    /** Shown in the inline bar while it runs, so the user can see which action they picked. */
    labelKey?: string;
}

/**
 * Provider errors are the only thing worth showing verbatim - "401 invalid x-api-key" tells the
 * user exactly what to fix, and no wording we could substitute would be more useful. This is the
 * same rule the draft dialog has always followed; it moved here so all four surfaces obey it.
 */
export function describeAiError(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return String(err);
}

/**
 * True when the request failed only because nothing is connected, which is an offer to connect
 * rather than an error - the user has not done anything wrong yet.
 */
export function isMissingProvider(err: unknown): boolean {
    return err instanceof NoAiProviderError;
}

/**
 * The markdown of a document range.
 *
 * Transform ops are defined over markdown, so handing the model plain text would quietly drop the
 * bold, the links and the list markers it is being asked to preserve. The serializer takes a
 * document, so the slice is wrapped in one; if that fails for an exotic selection we fall back to
 * flat text rather than sending nothing.
 */
export function markdownForRange(editor: Editor, from: number, to: number): string {
    const fallback = () => editor.state.doc.textBetween(from, to, '\n\n', ' ');
    if (!editor.markdown) return fallback();
    try {
        const content = editor.state.doc.slice(from, to).content.toJSON() as JSONContent[] | null;
        if (!content) return fallback();
        const markdown = editor.markdown.serialize({type: 'doc', content}).trim();
        return markdown || fallback();
    } catch {
        return fallback();
    }
}

/**
 * Orders the candidate pages for an Ask request, best first, and changes nothing else.
 *
 * Ranking is this side's job; fitting the result into a context window is not.
 * `trimAskSources` in the provider layer spends the budget whole pages first and keeps at most one
 * partial source, and it reads array order as relevance - so truncating here would truncate twice
 * and throw away the preference for whole pages before it could be applied.
 *
 * The score is deliberately a plain word overlap rather than the wiki's own search ranking: search
 * belongs to another stream and is tuned for "which page did I mean", while this only has to put
 * the likely pages in front. A page with no overlap at all still comes along at the back, because
 * a question nobody happened to word the same way is exactly the case where a strict filter
 * answers "the wiki does not cover that" about a page that was sitting right there.
 */
export function rankAskSources(
    candidates: readonly AiAskSource[],
    question: string,
): AiAskSource[] {
    const terms = question
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(term => term.length > 2);

    return candidates
        .map(source => {
            const title = source.title.toLowerCase();
            const body = source.content.toLowerCase();
            let score = 0;
            for (const term of terms) {
                if (title.includes(term)) score += 3;
                if (body.includes(term)) score += 1;
            }
            return {source, score};
        })
        .sort((a, b) => b.score - a.score || a.source.title.localeCompare(b.source.title))
        .map(entry => entry.source);
}
