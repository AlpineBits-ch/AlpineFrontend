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

export type AiTransformOp =
    'improve' | 'shorten' | 'expand' | 'grammar' | 'tone' | 'translate' | 'summarize' | 'continue';

export interface AiTransformRequest {
    op: AiTransformOp;
    /** The markdown the op applies to. */
    text: string;
    /** Extra instruction: a tone name, a target language, or the user's own words. */
    instruction?: string;
    title: string;
    pageTitles: readonly string[];
}

export interface AiAskSource {
    id: string;
    title: string;
    content: string;
}

export interface AiAskRequest {
    question: string;
    /** Candidate pages with bodies. The caller trims these to a sane budget. */
    sources: readonly AiAskSource[];
}

export interface AiCompleteRequest {
    /** Markdown immediately before the caret, tail-trimmed by the caller. */
    before: string;
    /** Markdown immediately after the caret, head-trimmed by the caller. */
    after: string;
    title: string;
}

export interface AiMetadataRequest {
    title: string;
    content: string;
    existingTags: readonly string[];
}

export interface AiMetadata {
    tags: string[];
    /** One-line description of the page. */
    summary: string;
    /** What this edit changed, for the revision summary field. */
    editSummary: string;
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
    draft(req: AiDraftRequest, apiKey: string, model: string, signal: AbortSignal): AsyncIterable<string>;

    /** Streams the rewritten passage, and nothing else - the result replaces the selection. */
    transform(
        req: AiTransformRequest,
        apiKey: string,
        model: string,
        signal: AbortSignal,
    ): AsyncIterable<string>;

    /**
     * Answers from wiki content. Cites sources as ordinary wiki links -
     * `[Page title](wiki:<pageId>)` - so the existing renderer resolves them with no new syntax.
     */
    ask(req: AiAskRequest, apiKey: string, model: string, signal: AbortSignal): AsyncIterable<string>;

    /** Ghost text. One short shot, not streamed: a half-rendered suggestion is worse than none. */
    complete(req: AiCompleteRequest, apiKey: string, model: string, signal: AbortSignal): Promise<string>;

    suggestMetadata(
        req: AiMetadataRequest,
        apiKey: string,
        model: string,
        signal: AbortSignal,
    ): Promise<AiMetadata>;
}

/**
 * No provider is connected, or the key that `configured` promised has gone from the keychain.
 *
 * Its own type so a caller can offer the connect flow instead of showing a provider error the
 * user cannot act on. Every `WikiAiService` method throws this rather than failing mutely.
 */
export class NoAiProviderError extends Error {
    constructor() {
        super('No AI provider is connected.');
        this.name = 'NoAiProviderError';
    }
}

/**
 * The model answered, but not in the shape we asked for.
 *
 * Distinct from a transport error because the fix is different: retrying a 500 may work, and
 * retrying malformed JSON from the same prompt usually will not. Callers that fill fields from
 * `suggestMetadata` must not guess at half-parsed output, so this is thrown instead of returning
 * a partly-populated object.
 */
export class AiResponseFormatError extends Error {
    constructor(detail: string) {
        super(`The model returned metadata we could not read: ${detail}`);
        this.name = 'AiResponseFormatError';
    }
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

// ---------------------------------------------------------------------------------------------
// transform
// ---------------------------------------------------------------------------------------------

export const AI_TRANSFORM_SYSTEM_PROMPT = [
    'You edit passages of a team wiki page.',
    'Return only the rewritten passage, as bare GitHub-flavoured Markdown. No preamble, no',
    '"Here is", no explanation, no sign-off, no surrounding quotes, and no code fence around the',
    'answer. The result replaces the passage verbatim in the editor, so anything you add that is',
    'not the passage ends up in the page.',
    'Keep the structure you were given unless the instruction is specifically to change it: a',
    'bulleted list stays a bulleted list, a heading stays a heading at the same level, and links,',
    'code spans and code blocks survive untouched.',
    'Never invent facts about this team, product or wiki that the passage does not already state',
    'or imply.',
].join(' ');

/**
 * What each op asks for, in the model's own instruction slot.
 *
 * Kept as data rather than a switch so the set stays visibly parallel - every op is one sentence
 * of intent, and it is obvious at a glance which ones consume `instruction`.
 */
const TRANSFORM_INSTRUCTIONS: Record<AiTransformOp, string> = {
    improve:
        'Rewrite the passage so it reads better - clearer, tighter, better organised. Keep ' +
        'every fact and every link it already contains.',
    shorten:
        'Make the passage shorter while keeping everything that matters. Cut hedging, ' +
        'repetition and filler first; drop facts only as a last resort.',
    expand:
        'Expand the passage with the detail a reader would want next. Add only what follows ' +
        'from what is already there - do not invent specifics you were not given.',
    grammar:
        'Fix spelling, grammar and punctuation only. Do not change wording, tone, structure ' +
        'or meaning beyond what those corrections require.',
    tone: 'Rewrite the passage in the requested tone, keeping its facts and structure.',
    translate:
        'Translate the passage into the requested language. Translate prose only: code, ' +
        'identifiers, URLs and link targets stay exactly as they are.',
    summarize: 'Summarise the passage. Return the summary alone - it replaces the passage.',
    // The one op whose output is an addition rather than a replacement. The editor decides where
    // it lands; all this side has to do is not repeat what it was given.
    continue:
        'Continue the passage from where it stops. Return only the new text that follows ' +
        'it, never a repeat of the passage itself.',
};

export function buildTransformPrompt(req: AiTransformRequest): string {
    const parts = [`Page title: ${req.title || 'Untitled'}`];
    if (req.pageTitles.length) {
        parts.push(`Other pages in this wiki: ${req.pageTitles.join(', ')}`);
    }
    parts.push('', `Instruction: ${TRANSFORM_INSTRUCTIONS[req.op]}`);

    const extra = req.instruction?.trim();
    if (extra) {
        // Named separately from the op instruction so a tone name or a target language is not
        // read as a competing rewrite request.
        parts.push(`From the user: ${extra}`);
    }

    parts.push('', 'The passage begins on the next line and runs to the end of this message.', '', req.text);
    return parts.join('\n');
}

// ---------------------------------------------------------------------------------------------
// ask
// ---------------------------------------------------------------------------------------------

export const AI_ASK_SYSTEM_PROMPT = [
    'You answer questions about a team wiki using only the wiki pages supplied with the question.',
    'The rules, in order of importance:',
    '(1) Never state anything the sources do not support. If they do not answer the question, say',
    'so plainly in one sentence - "This wiki does not cover that" - and stop. A confident wrong',
    'answer is far worse than no answer.',
    '(2) Cite every claim with an ordinary Markdown link to the page it came from, written exactly',
    'as [Page title](wiki:PAGE_ID) with the id given for that source. Each source block tells you',
    'the exact link to use. Put the citation inline, right after the sentence it supports.',
    '(3) The sources may be partial: long pages are truncated and lower-ranked pages left out',
    'entirely. If the answer looks like it depends on a part you cannot see, answer with what you',
    'have and say what is missing.',
    '(4) Do not answer from general knowledge, even when you are certain. The question is about',
    'this wiki, and an answer that is true in general but absent from the wiki reads as though the',
    'wiki says it.',
    '(5) Answer in bare GitHub-flavoured Markdown - a short paragraph or a short list. No preamble,',
    'no restating of the question, no code fence around the whole answer.',
].join(' ');

/**
 * How much source text one question may carry, in characters.
 *
 * Roughly four characters to a token, so ~12k tokens of wiki - comfortable inside the smallest
 * context window any of the three providers' current models offers, with room left for the answer
 * and for a long question. The ceiling is as much about money as about context: the user pays for
 * every one of these tokens out of their own provider account, and a wiki has no upper bound on
 * size, so an untrimmed "ask" over a large wiki would be a surprise on their next invoice.
 */
export const ASK_SOURCE_BUDGET = 48_000;

/**
 * Below this many characters a truncated page is not worth its own header - it is a paragraph of
 * context and a citation the model may well hang a wrong claim on. Better to omit the page and let
 * the answer say the sources were partial.
 */
export const ASK_MIN_SOURCE_CHARS = 500;

export interface TrimmedAskSource extends AiAskSource {
    /** True when only the head of this page made it into the budget. */
    truncated: boolean;
}

export interface TrimmedAskSources {
    /** Kept in the order the caller supplied, which is the order it ranked them in. */
    sources: TrimmedAskSource[];
    /** How many candidates did not fit at all. */
    omitted: number;
    /** Anything was truncated or omitted, so the answer must say the sources were partial. */
    partial: boolean;
}

/**
 * Fits the candidate pages into the budget, whole pages first.
 *
 * Two passes rather than one, because a half page is a much worse source than a whole one: the
 * first pass takes every page that fits entirely, in rank order, and only then does the second
 * pass spend whatever is left on the head of the best page that did not fit. That way one long
 * page near the top of the ranking cannot crowd out three short ones below it, and at most one
 * source in the prompt is ever partial.
 */
export function trimAskSources(
    sources: readonly AiAskSource[],
    budget: number = ASK_SOURCE_BUDGET,
): TrimmedAskSources {
    const kept: {rank: number; source: TrimmedAskSource}[] = [];
    const skipped: {rank: number; source: AiAskSource}[] = [];
    let remaining = Math.max(0, budget);

    sources.forEach((source, rank) => {
        const content = source.content ?? '';
        if (content.length <= remaining) {
            kept.push({rank, source: {...source, content, truncated: false}});
            remaining -= content.length;
        } else {
            skipped.push({rank, source});
        }
    });

    if (skipped.length && remaining >= ASK_MIN_SOURCE_CHARS) {
        const best = skipped.shift()!;
        kept.push({
            rank: best.rank,
            source: {...best.source, content: cutAtBoundary(best.source.content, remaining), truncated: true},
        });
    }

    kept.sort((a, b) => a.rank - b.rank);
    return {
        sources: kept.map(entry => entry.source),
        omitted: skipped.length,
        partial: skipped.length > 0 || kept.some(entry => entry.source.truncated),
    };
}

/** Cuts at the last paragraph, line or word break before `max`, so a page never ends mid-word. */
function cutAtBoundary(text: string, max: number): string {
    if (text.length <= max) return text;
    const head = text.slice(0, max);
    for (const marker of ['\n\n', '\n', ' ']) {
        const at = head.lastIndexOf(marker);
        // Only honour a break in the last quarter; an early one throws away most of the budget.
        if (at > max * 0.75) return head.slice(0, at).trimEnd();
    }
    return head.trimEnd();
}

export function buildAskPrompt(req: AiAskRequest, budget: number = ASK_SOURCE_BUDGET): string {
    const trimmed = trimAskSources(req.sources, budget);
    const parts: string[] = [];

    if (!trimmed.sources.length) {
        // Said out loud rather than left as an empty section: a prompt with no sources and no
        // explanation invites the model to answer from general knowledge, which is rule (4).
        parts.push('No wiki pages were found for this question. Say that the wiki does not cover it.');
    } else {
        parts.push(`Wiki pages (${trimmed.sources.length}), highest ranked first:`);
        for (const source of trimmed.sources) {
            const title = source.title || 'Untitled';
            parts.push('', `--- Source: ${title}`, `Cite as: [${title}](wiki:${source.id})`);
            if (source.truncated) {
                parts.push('Note: this page is truncated - only its opening is shown.');
            }
            parts.push('', source.content.trim() || '(this page is empty)');
        }
        if (trimmed.partial) {
            parts.push(
                '',
                trimmed.omitted > 0
                    ? `${trimmed.omitted} lower-ranked page(s) did not fit and are not shown. ` +
                          'The sources above are partial.'
                    : 'The sources above are partial - at least one page was truncated.',
            );
        }
    }

    parts.push('', `Question: ${req.question}`);
    return parts.join('\n');
}

// ---------------------------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------------------------

export const AI_COMPLETE_SYSTEM_PROMPT = [
    'You are the inline autocomplete in a team wiki editor.',
    'Continue the text before the caret by at most one sentence, one list item, or one short',
    'clause, stopping at a natural boundary.',
    'Return only the continuation. Never repeat any of the text before the caret, never restate it,',
    'never explain, never add quotes or a code fence. Start with the exact character that should',
    'come next, including a leading space if the text before the caret ends on a word.',
    'If there is not enough to go on to write something the author would plausibly have written',
    'themselves, return nothing at all. An empty answer costs the author nothing; a wrong guess',
    'costs them a read and a keystroke.',
].join(' ');

/**
 * Under this many characters of preceding text there is nothing to continue *from* - whatever
 * came back would be the model's idea of the page, appearing under the author's cursor as if it
 * were theirs. Checked before the request so a thin context costs neither latency nor credit.
 */
export const COMPLETE_MIN_CONTEXT = 12;

/** Hard cap on a suggestion, in characters. Ghost text longer than this stops reading as a hint. */
export const COMPLETE_MAX_CHARS = 240;

export function shouldSkipCompletion(req: AiCompleteRequest): boolean {
    return req.before.trim().length < COMPLETE_MIN_CONTEXT;
}

export function buildCompletePrompt(req: AiCompleteRequest): string {
    const parts = [`Page title: ${req.title || 'Untitled'}`];

    const after = req.after.trim();
    if (after) {
        // Given first, and labelled, so the model writes something that leads into what follows
        // instead of duplicating it. The text to continue has to be last - see below.
        parts.push(
            '',
            'Text after the caret (do not repeat it, write something that leads into it):',
            '',
            after,
        );
    }

    // Last on purpose: the continuation is generated straight off the end of the message, and
    // anything placed after it here would be the thing the model continues instead.
    parts.push('', 'Text before the caret - continue from its final character:', '', req.before);
    return parts.join('\n');
}

/**
 * Makes a raw completion safe to render as ghost text.
 *
 * Three failure modes worth handling, all of them common: the model fences the answer, it echoes
 * the tail of the text it was given before continuing, and it writes three paragraphs when asked
 * for a sentence. Everything else is passed through untouched - including leading whitespace,
 * which is load-bearing when the caret sits at the end of a word.
 */
export function sanitizeCompletion(before: string, raw: string): string {
    let text = stripOuterFence(raw);
    if (!text.trim()) return '';

    text = dropEchoedPrefix(before, text);

    // One paragraph at most: a blank line means the model started a new thought, which is past
    // the "one sentence" the prompt asked for.
    const paragraphBreak = text.search(/\n[ \t]*\n/);
    if (paragraphBreak >= 0) text = text.slice(0, paragraphBreak);

    if (text.length > COMPLETE_MAX_CHARS) {
        const head = text.slice(0, COMPLETE_MAX_CHARS);
        const space = head.lastIndexOf(' ');
        text = space > COMPLETE_MAX_CHARS * 0.5 ? head.slice(0, space) : head;
    }

    // Trailing whitespace only. A leading space is load-bearing when the caret sits at the end
    // of a word, so it survives.
    return text.replace(/\s+$/, '');
}

/**
 * Removes a repeat of the end of `before` from the front of the completion.
 *
 * Matches the longest overlap first: a short one is likely a coincidence ("the " ends half the
 * sentences in a wiki), while a long one is unambiguously the model restating its input.
 */
function dropEchoedPrefix(before: string, text: string): string {
    const leading = text.length - text.trimStart().length;
    const body = text.slice(leading);
    const max = Math.min(before.length, 200);

    for (let n = max; n >= 16; n--) {
        const tail = before.slice(before.length - n);
        if (body.startsWith(tail)) return body.slice(n);
    }
    return text;
}

/**
 * Picks the model a latency-sensitive call should use.
 *
 * Ghost text fires on a typing pause, so the flagship model the user picked for drafting is the
 * wrong tool: it is slower than the pause it is meant to fill and costs many times more per
 * suggestion. A user who has already chosen a small model keeps it, though - overriding a
 * deliberate downgrade would spend more of their credit than they asked to spend.
 */
export function pickFastModel(configured: string, fallback: string): string {
    return /(-mini|-nano|-lite|haiku|flash)/i.test(configured) ? configured : fallback;
}

// ---------------------------------------------------------------------------------------------
// suggestMetadata
// ---------------------------------------------------------------------------------------------

export const AI_METADATA_SYSTEM_PROMPT = [
    'You label pages for a team wiki. You are given a page and you return JSON describing it.',
    'tags: three to six short lowercase topic tags. Reuse an existing wiki tag whenever it fits -',
    'a near-duplicate of a tag that already exists splits the wiki in two. No spaces inside a tag;',
    'use a hyphen. Do not tag with the page title.',
    'summary: one plain sentence saying what the page is, for a search result and a link preview.',
    'No marketing, no "this page", under 160 characters.',
    'editSummary: one short phrase in the past tense describing what this version of the page',
    'covers, the way a commit message would. Under 80 characters.',
    'Describe only what the page actually says. Return JSON and nothing else.',
].join(' ');

/**
 * The response schema, in the JSON Schema subset all three providers accept.
 *
 * Deliberately flat and free of `minItems`/`maxItems`: OpenAI's strict mode rejects those, and a
 * schema that has to be forked per provider is a schema that drifts. Counts are asked for in the
 * prompt and enforced in `parseAiMetadata` instead.
 *
 * Typed as `Record<string, unknown>` because that is exactly what all three SDKs take for a raw
 * schema, and a narrower literal type would not be assignable to any of them.
 */
export const AI_METADATA_SCHEMA: Record<string, unknown> = {
    type: 'object',
    properties: {
        tags: {
            type: 'array',
            description: 'Three to six short lowercase topic tags.',
            items: {type: 'string'},
        },
        summary: {
            type: 'string',
            description: 'One plain sentence saying what the page is.',
        },
        editSummary: {
            type: 'string',
            description: 'A short past-tense phrase describing what this version covers.',
        },
    },
    required: ['tags', 'summary', 'editSummary'],
    additionalProperties: false,
};

/** Enough tags to describe a page, few enough that the tag list stays navigable. */
export const AI_METADATA_MAX_TAGS = 6;

export function buildMetadataPrompt(req: AiMetadataRequest): string {
    const parts = [`Page title: ${req.title || 'Untitled'}`];
    if (req.existingTags.length) {
        parts.push('', `Tags already used in this wiki (prefer these): ${req.existingTags.join(', ')}`);
    }
    parts.push('', 'Page content:', '', req.content.trim() || '(this page is empty)');
    return parts.join('\n');
}

/**
 * Reads the model's JSON into `AiMetadata`, or throws.
 *
 * Defensive about the wrapping - a fence, or a sentence either side of the object - because that
 * is the model being chatty rather than being wrong. Strict about the fields, because the caller
 * writes these straight into the page's tags and summary: half-parsed metadata that silently
 * blanks a summary is worse than an error the user can dismiss.
 */
export function parseAiMetadata(raw: string): AiMetadata {
    const text = extractJsonObject(stripOuterFence(raw));
    if (!text) throw new AiResponseFormatError('no JSON object in the response');

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new AiResponseFormatError(err instanceof Error ? err.message : 'unparseable JSON');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new AiResponseFormatError('the response was not a JSON object');
    }
    const value = parsed as Record<string, unknown>;

    if (typeof value['summary'] !== 'string') {
        throw new AiResponseFormatError('"summary" was missing or not a string');
    }
    if (typeof value['editSummary'] !== 'string') {
        throw new AiResponseFormatError('"editSummary" was missing or not a string');
    }
    const rawTags = value['tags'];
    if (rawTags !== undefined && !Array.isArray(rawTags)) {
        throw new AiResponseFormatError('"tags" was not an array');
    }

    return {
        tags: normaliseTags(rawTags ?? []),
        summary: value['summary'].trim(),
        editSummary: value['editSummary'].trim(),
    };
}

/** Finds the outermost `{...}` so a preamble or a trailing remark does not fail the parse. */
function extractJsonObject(text: string): string | null {
    const open = text.indexOf('{');
    const close = text.lastIndexOf('}');
    return open >= 0 && close > open ? text.slice(open, close + 1) : null;
}

function normaliseTags(raw: readonly unknown[]): string[] {
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        const tag = entry.trim().replace(/\s+/g, '-').slice(0, 32);
        if (!tag) continue;
        // Case-insensitively unique: "Deploy" and "deploy" are one tag to a reader, and letting
        // both through is exactly the wiki-splitting the prompt asks the model to avoid.
        const fold = tag.toLowerCase();
        if (seen.has(fold)) continue;
        seen.add(fold);
        tags.push(tag);
        if (tags.length === AI_METADATA_MAX_TAGS) break;
    }
    return tags;
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
