/**
 * In-document search, the half that needs no editor.
 *
 * A block is one textblock's flattened text plus the document position of its first character, so
 * a match found in the string is a document range by addition. Flattening is what makes marks
 * invisible here: bold, a link and plain text inside one paragraph are one string, and a query
 * straddling them matches like any other.
 */

export interface WikiFindOptions {
    caseSensitive?: boolean;
    wholeWord?: boolean;
}

export interface TextRange {
    from: number;
    to: number;
}

export interface FindBlock {
    text: string;
    /** Document position of `text[0]`. */
    base: number;
}

/** Same class as `wiki-links`, so "whole word" means the same thing in both places. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Matches are non-overlapping and left to right: searching "aa" in "aaaa" answers twice, not
 * three times, which is what a find bar counts.
 */
export function findMatchesInText(text: string, query: string, options: WikiFindOptions = {}): TextRange[] {
    if (!query) return [];
    const haystack = options.caseSensitive ? text : text.toLowerCase();
    const needle = options.caseSensitive ? query : query.toLowerCase();
    // Length must survive the fold, or every offset after a special-casing character is wrong.
    if (haystack.length !== text.length || needle.length !== query.length) {
        return findMatchesInText(text, query, {...options, caseSensitive: true});
    }

    const found: TextRange[] = [];
    let at = 0;
    while (at <= haystack.length - needle.length) {
        const index = haystack.indexOf(needle, at);
        if (index < 0) break;
        if (!options.wholeWord || isWholeWord(haystack, index, needle.length)) {
            found.push({from: index, to: index + needle.length});
            at = index + needle.length;
        } else {
            at = index + 1;
        }
    }
    return found;
}

export function findMatchesInBlocks(
    blocks: readonly FindBlock[],
    query: string,
    options: WikiFindOptions = {},
): TextRange[] {
    const found: TextRange[] = [];
    for (const block of blocks) {
        for (const match of findMatchesInText(block.text, query, options)) {
            found.push({from: block.base + match.from, to: block.base + match.to});
        }
    }
    return found;
}

/** The match at or after `pos`, else the last one. -1 when there are none. */
export function matchNearest(matches: readonly TextRange[], pos: number): number {
    if (!matches.length) return -1;
    const index = matches.findIndex(match => match.from >= pos);
    return index === -1 ? matches.length - 1 : index;
}

/** Boundaries are read off the match's own edges, so "C++" and "Q&A" both behave. */
function isWholeWord(text: string, at: number, length: number): boolean {
    const before = at > 0 ? text[at - 1] : '';
    const after = at + length < text.length ? text[at + length] : '';
    if (before && WORD_CHAR.test(before) && WORD_CHAR.test(text[at])) return false;
    return !(after && WORD_CHAR.test(after) && WORD_CHAR.test(text[at + length - 1]));
}
