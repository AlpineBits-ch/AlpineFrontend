import {Editor, JSONContent} from '@tiptap/core';
// Side-effect import: `editor.markdown` reaches `Editor` through this package's module augmentation, so a compilation that doesn't otherwise pull it in (a spec whose import graph never reaches `wiki-extensions.ts`) wouldn't know the property exists.
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

/** What a transform reads and what it is allowed to overwrite. */
export interface WikiAiTransformScope {
    /** The markdown handed to the model. */
    text: string;
    /** The range the result replaces. `from === to` means insert rather than replace. */
    from: number;
    to: number;
}

/**
 * What a transform acts on when the user has not selected anything.
 *
 * The bubble menu can only be reached with a selection, so for a long time every transform
 * assumed one. The slash menu cannot: by the time a row is chosen the `/summarize` trigger text
 * has been deleted and the caret is sitting on its own in an otherwise untouched page. Every AI
 * row in that menu therefore hit a `from === to` guard and returned without a request, a bar or a
 * message - the menu closed and nothing else happened.
 *
 * So an absent selection is read as an intent rather than as a missing argument:
 *
 * - the caret is inside a block with text - that block is the passage, which is what every other
 *   editor means by running a command "here";
 * - the caret is on an empty line - the page is the passage, which is what the menu already
 *   promises ("Condense this page to its point").
 *
 * The result normally replaces what it read. Two cases add instead: `continue` always, because it
 * was asked to carry on rather than to rewrite, and `summarize` when nothing was selected, because
 * "summarize" over a whole page would otherwise delete the page and leave its summary behind.
 * Returns null when there is genuinely nothing to work on, which the caller must report rather
 * than swallow.
 */
export function resolveTransformScope(editor: Editor, op: AiTransformOp): WikiAiTransformScope | null {
    const {from, to} = editor.state.selection;
    const selected = from !== to;
    const range = selected ? {from, to} : enclosingRange(editor);
    const text = markdownForRange(editor, range.from, range.to).trim();
    if (!text) return null;

    if (op !== 'continue' && !(op === 'summarize' && !selected)) return {text, ...range};
    // Additive ops land where the user asked for them: at the end of a selection they made, or
    // at the caret they left, never at the end of whatever the scope happened to read.
    const at = selected ? range.to : to;
    return {text, from: at, to: at};
}

/** The caret's own block when it holds text, otherwise the whole document. */
function enclosingRange(editor: Editor): {from: number; to: number} {
    const {$from} = editor.state.selection;
    if ($from.depth > 0 && $from.parent.isTextblock && $from.parent.textContent.trim()) {
        return {from: $from.start(), to: $from.end()};
    }
    return {from: 0, to: editor.state.doc.content.size};
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
export function rankAskSources(candidates: readonly AiAskSource[], question: string): AiAskSource[] {
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
