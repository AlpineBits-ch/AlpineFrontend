/**
 * Turning an answer into something clickable. Answers cite pages as ordinary wiki links,
 * `[Page title](wiki:<pageId>)`, the same form the editor stores. DOMPurify's URI allowlist drops
 * the `wiki:` protocol, so the answer is split here into plain segments and rendered by the
 * template, with no HTML sink involved: a model's output must never be handed to `innerHTML`.
 */

/** One run of an answer. `pageId` set means it is a citation and `text` is the link label; deliberately one shape rather than a discriminated union, so the template can render it without leaning on type narrowing inside a `@for`. */
export interface AnswerSegment {
    text: string;
    pageId: string | null;
}

const CITATION_RE = /\[([^\]]+)]\(wiki:([^)\s]+)\)/g;

export function splitAnswer(markdown: string): AnswerSegment[] {
    const segments: AnswerSegment[] = [];
    let last = 0;

    for (const match of markdown.matchAll(CITATION_RE)) {
        const start = match.index ?? 0;
        if (start > last) segments.push({text: markdown.slice(last, start), pageId: null});
        segments.push({text: match[1], pageId: match[2]});
        last = start + match[0].length;
    }
    if (last < markdown.length) segments.push({text: markdown.slice(last), pageId: null});
    return segments;
}

/** The pages an answer actually cited, in first-mention order and without repeats. */
export function citedPageIds(markdown: string): string[] {
    const ids: string[] = [];
    for (const segment of splitAnswer(markdown)) {
        if (segment.pageId && !ids.includes(segment.pageId)) ids.push(segment.pageId);
    }
    return ids;
}

export interface AskTurnSummary {
    question: string;
    answer: string;
}

/**
 * Folds the session's earlier turns into the question, since `AiAskRequest` carries only a
 * question and sources. History is stated as part of the question text itself, capped to the last
 * few turns so an unbounded transcript doesn't grow the request without bound.
 */
export function buildAskQuestion(history: readonly AskTurnSummary[], question: string, maxTurns = 3): string {
    const recent = history.filter(turn => turn.answer.trim()).slice(-maxTurns);
    if (!recent.length) return question;

    const transcript = recent.map(turn => `Q: ${turn.question}\nA: ${turn.answer}`).join('\n\n');
    return `Earlier in this conversation:\n\n${transcript}\n\nFollow-up question: ${question}`;
}
