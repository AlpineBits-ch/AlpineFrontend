/**
 * Internal page links.
 *
 * A wiki link is an ordinary markdown link with a `wiki:<pageId>` href, not a custom TipTap node.
 * That choice is what lets links survive save/load for free: the existing markdown serializer
 * already round-trips link marks, so no custom parseMarkdown/renderMarkdown is needed, and the
 * content stays readable anywhere it is viewed outside the app.
 */

export const WIKI_LINK_PROTOCOL = 'wiki';

/** Anchored, so `wikipedia:` cannot match. Requires at least one id character. */
const WIKI_HREF_RE = /^wiki:(.+)$/;

/**
 * Matches the href half of a markdown link. The label is deliberately not captured - labels can
 * contain nested brackets, and matching only `](wiki:...)` sidesteps that entirely.
 */
const MD_WIKI_LINK_RE = /]\(wiki:([^)\s]+)\)/g;

/** A page id followed by an optional heading anchor, the way a URL carries a fragment. */
export interface WikiTarget {
    pageId: string;
    /** A `wiki-toc` entry id, or null when the link points at the page as a whole. */
    headingId: string | null;
}

export function wikiHref(pageId: string, headingId?: string | null): string {
    const target = `${WIKI_LINK_PROTOCOL}:${pageId}`;
    return headingId ? `${target}#${headingId}` : target;
}

/**
 * Splits a `wiki:` href into the page it names and the section within it.
 *
 * Fragments are stripped here rather than at each call site, so every existing caller that only
 * wants a page id keeps working when it is handed a link to a section of that page.
 */
export function parseWikiTarget(href: string | null | undefined): WikiTarget | null {
    if (!href) return null;
    const match = WIKI_HREF_RE.exec(href);
    if (!match) return null;
    const hash = match[1].indexOf('#');
    if (hash < 0) return {pageId: match[1], headingId: null};
    const pageId = match[1].slice(0, hash);
    // `wiki:#overview` names a section of nothing, which is not a link we can follow.
    if (!pageId) return null;
    return {pageId, headingId: match[1].slice(hash + 1) || null};
}

export function parseWikiHref(href: string | null | undefined): string | null {
    return parseWikiTarget(href)?.pageId ?? null;
}

export function extractLinkedPageIds(markdown: string): string[] {
    const ids = new Set<string>();
    for (const match of markdown.matchAll(MD_WIKI_LINK_RE)) {
        const id = match[1].split('#')[0];
        // A link to a section still links the page, so backlinks must count it.
        if (id) ids.add(id);
    }
    return [...ids];
}

/**
 * Inverts "page -> pages it links to" into "page -> pages that link to it".
 *
 * Self-links are dropped: a page that references itself would otherwise report a backlink from
 * itself, which reads as "1 page links here" on a page nothing actually links to.
 */
export function buildBacklinkIndex(contentByPageId: ReadonlyMap<string, string>): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const [sourceId, content] of contentByPageId) {
        for (const targetId of extractLinkedPageIds(content)) {
            if (targetId === sourceId) continue;
            const sources = index.get(targetId);
            if (sources) {
                if (!sources.includes(sourceId)) sources.push(sourceId);
            } else {
                index.set(targetId, [sourceId]);
            }
        }
    }
    return index;
}

/** A page that names this one in prose without linking it. */
export interface UnlinkedMention {
    sourceId: string;
    /** Offset of the first plain-text occurrence in the source markdown. */
    index: number;
    /** The occurrence exactly as written, so a fix can keep the author's own casing. */
    text: string;
    /** How many plain-text occurrences that page has. */
    count: number;
}

/**
 * The complement of the backlink index: pages that mention this one in prose and never link it.
 *
 * Pages that already link the target are skipped rather than listed twice - they are backlinks,
 * and reporting the same page under both headings reads as two separate findings.
 */
export function findUnlinkedMentions(
    target: {id: string; title: string},
    contentByPageId: ReadonlyMap<string, string>,
): UnlinkedMention[] {
    const title = target.title.trim();
    if (!title) return [];
    const mentions: UnlinkedMention[] = [];
    for (const [sourceId, content] of contentByPageId) {
        // A page naming its own title is not a link it is missing.
        if (sourceId === target.id) continue;
        if (extractLinkedPageIds(content).includes(target.id)) continue;
        const hits = findPlainOccurrences(content, title);
        if (!hits.length) continue;
        mentions.push({
            sourceId,
            index: hits[0],
            text: content.slice(hits[0], hits[0] + title.length),
            count: hits.length,
        });
    }
    return mentions;
}

/**
 * Rewrites the first plain-text mention into a wiki link and leaves the rest of the body byte for
 * byte. First occurrence only, which is the wiki convention and also what makes the result
 * predictable: the page moves out of "unlinked mentions" and into "linked from" in one step.
 *
 * Returns null when there is nothing safe to do - no mention, or a title carrying brackets, which
 * would produce a link the markdown parser reads as something else entirely.
 */
export function linkFirstMention(markdown: string, title: string, pageId: string): string | null {
    const needle = title.trim();
    if (!needle || /[[\]]/.test(needle)) return null;
    const [at] = findPlainOccurrences(markdown, needle);
    if (at === undefined) return null;
    const matched = markdown.slice(at, at + needle.length);
    return `${markdown.slice(0, at)}[${matched}](${wikiHref(pageId)})${markdown.slice(at + needle.length)}`;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Every offset at which `phrase` appears as prose: case-insensitive, whole words only, and never
 * inside a code block, a code span, a link or a URL.
 *
 * Offsets index the original markdown, not the masked copy, so a caller can splice with them.
 */
export function findPlainOccurrences(markdown: string, phrase: string): number[] {
    const needle = phrase.trim();
    if (!needle) return [];
    const prose = maskNonProse(markdown);
    const found: number[] = [];
    // A regex rather than a lowercased copy of both sides: `toLowerCase` is not
    // length-preserving for every script, and a single shifted character would corrupt offsets
    // used to splice a link into the document.
    const search = new RegExp(escapeRegExp(needle), 'gi');
    let match: RegExpExecArray | null;
    while ((match = search.exec(prose)) !== null) {
        if (isWholeWord(prose, match.index, needle.length)) found.push(match.index);
        // Overlapping occurrences of a repeated phrase are still separate mentions.
        search.lastIndex = match.index + 1;
    }
    return found;
}

/**
 * Replaces everything that is not prose with a filler character, preserving length.
 *
 * Length preservation is the point: offsets into the result are offsets into the original, so a
 * match found here can be spliced there. Masked regions cannot be matched across either, because
 * the filler appears in no title.
 */
export function maskNonProse(markdown: string): string {
    // `split('')`, not spread: spreading splits by code point, and one emoji earlier in the page
    // would then shift every offset after it out of step with `String.prototype.slice`.
    const chars = markdown.split('');
    maskFencedCode(chars, markdown);
    maskCodeSpans(chars);
    maskLinks(chars);
    maskBareUrls(chars);
    return chars.join('');
}

/** Not a character any title contains, and not a word character, so it breaks every match. */
const MASK = '\u0000';

function maskRange(chars: string[], from: number, to: number): void {
    for (let i = Math.max(0, from); i < Math.min(to, chars.length); i++) {
        // Newlines survive so the masked copy keeps the original's line structure.
        if (chars[i] !== '\n') chars[i] = MASK;
    }
}

/**
 * Fenced blocks are line-oriented, so they are found by walking lines rather than by a regex over
 * the whole document. An unterminated fence masks to the end - that is how a renderer reads it too.
 */
function maskFencedCode(chars: string[], markdown: string): void {
    let open: string | null = null;
    let offset = 0;
    for (const line of markdown.split('\n')) {
        const fence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
        if (open) {
            maskRange(chars, offset, offset + line.length);
            const closes =
                fence &&
                fence[1][0] === open[0] &&
                fence[1].length >= open.length &&
                line.slice(fence[0].length).trim() === '';
            if (closes) open = null;
        } else if (fence) {
            open = fence[1];
            maskRange(chars, offset, offset + line.length);
        }
        offset += line.length + 1;
    }
}

/** Backtick runs close on a run of the same length; an unclosed run is ordinary prose. */
function maskCodeSpans(chars: string[]): void {
    let i = 0;
    while (i < chars.length) {
        if (chars[i] !== '`') {
            i++;
            continue;
        }
        const start = i;
        while (chars[i] === '`') i++;
        const width = i - start;
        let j = i;
        let closed = false;
        while (j < chars.length) {
            if (chars[j] !== '`') {
                j++;
                continue;
            }
            let end = j;
            while (chars[end] === '`') end++;
            if (end - j === width) {
                maskRange(chars, start, end);
                i = end;
                closed = true;
                break;
            }
            j = end;
        }
        if (!closed) i = start + width;
    }
}

/**
 * Masks whole `[label](href)` links, images included.
 *
 * The label goes with the href: a mention inside a link's own text is already a link, just not to
 * this page, and markdown forbids nesting one inside the other anyway.
 */
function maskLinks(chars: string[]): void {
    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== '[') continue;
        let depth = 1;
        let j = i + 1;
        while (j < chars.length && depth > 0) {
            if (chars[j] === '[') depth++;
            else if (chars[j] === ']') depth--;
            j++;
        }
        // Brackets that open no link are ordinary punctuation and must not swallow the prose
        // after them.
        if (depth !== 0 || chars[j] !== '(') continue;
        let nesting = 1;
        let k = j + 1;
        while (k < chars.length && nesting > 0) {
            if (chars[k] === '(') nesting++;
            else if (chars[k] === ')') nesting--;
            k++;
        }
        if (nesting !== 0) continue;
        maskRange(chars, i > 0 && chars[i - 1] === '!' ? i - 1 : i, k);
        i = k - 1;
    }
}

/** A title inside a bare URL is a path segment, not a mention somebody forgot to link. */
function maskBareUrls(chars: string[]): void {
    const text = chars.join('');
    const url = /\b(?:https?|mailto|wiki):\S+/g;
    let match: RegExpExecArray | null;
    while ((match = url.exec(text)) !== null) {
        maskRange(chars, match.index, match.index + match[0].length);
    }
}

/**
 * Boundaries are checked against the phrase's own edges, not assumed: a title like "Q&A" ends in a
 * word character but a title like "C++" does not, and `\b` gets the second one wrong.
 */
function isWholeWord(text: string, at: number, length: number): boolean {
    const before = at > 0 ? text[at - 1] : '';
    const after = at + length < text.length ? text[at + length] : '';
    if (before && WORD_CHAR.test(before) && WORD_CHAR.test(text[at])) return false;
    return !(after && WORD_CHAR.test(after) && WORD_CHAR.test(text[at + length - 1]));
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
