/**
 * Word count and reading time. Counts prose, not markup: a page whose body is mostly link targets
 * and table pipes is not the twenty-minute read the raw character count claims. Pure and separate
 * from the rail so the stripping rules can be tested without a component.
 */

export interface PageStats {
    words: number;
    /** Characters of prose, markup already removed. */
    characters: number;
    /** Whole minutes, rounded up from the first word so nothing reads as "0 min". */
    minutes: number;
}

/** The figure most reading-time estimates use for adult silent reading of ordinary prose. */
const WORDS_PER_MINUTE = 200;

export function pageStats(markdown: string): PageStats {
    const prose = proseOf(markdown);
    const words = prose ? prose.split(' ').filter(Boolean).length : 0;
    return {
        words,
        characters: prose.length,
        minutes: words ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : 0,
    };
}

/**
 * Markdown reduced to the text a reader actually reads. Code inside a fence stays, since it is
 * content somebody has to read, but the fence markers, image syntax, link targets and emphasis
 * characters go, because none of them is a word.
 */
function proseOf(markdown: string): string {
    return markdown
        // Fence markers and their info string, never the code between them.
        .replace(/^[ \t]{0,3}(?:`{3,}|~{3,}).*$/gm, ' ')
        // An image contributes no prose; its alt text is a label, not a sentence.
        .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
        // A link keeps its label and loses its target.
        .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
        // Pages saved before the markdown switch are stored as HTML.
        .replace(/<[^>]+>/g, ' ')
        .replace(/^[ \t]*[>#]+[ \t]*/gm, ' ')
        .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, ' ')
        // Table pipes and the dashed separator row.
        .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, ' ')
        .replace(/\|/g, ' ')
        .replace(/[*_~`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
