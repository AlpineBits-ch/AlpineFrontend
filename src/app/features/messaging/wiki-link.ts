/** Wiki page links, as they travel through chat. */

/** Where a shared page id is turned back into a place: `/wiki/<guildId>/<pageId>`. */
const WIKI_URL_SOURCE =
    'https:\\/\\/venta\\.gg\\/wiki\\/([A-Za-z0-9_-]+)\\/([A-Za-z0-9_-]+)(?:\\/[^\\s<>]*)?';

/** The whole string is one wiki link and nothing else. */
export function parseWikiUrl(text: string): {guildId: string; pageId: string} | null {
    const match = new RegExp(`^${WIKI_URL_SOURCE}$`).exec(text.trim());
    return match ? {guildId: match[1], pageId: match[2]} : null;
}

/** The link to put in a message. */
export function wikiShareLink(guildId: string, pageId: string): string {
    return wikiUrl(guildId, pageId);
}

/** The bare URL, for "copy link". */
export function wikiUrl(guildId: string, pageId: string): string {
    return `https://venta.gg/wiki/${guildId}/${pageId}`;
}

/** A plain-text preview of a page body, for the card. */
export function wikiSnippet(markdown: string, max = 180): string {
    const text = markdown
        // Fenced code first - its contents must not be read as markup.
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
        // A callout's marker line names its kind and carries no prose. Before the blockquote rule,
        // which would otherwise leave a bare "[!NOTE]" as the first thing the card says.
        .replace(/^\s{0,3}>\s*\[!\w+]\s*$/gm, ' ')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        // A setext underline is decoration for the line above, and reads as debris on its own.
        .replace(/^\s{0,3}(={2,}|-{2,})\s*$/gm, ' ')
        .replace(/^\s{0,3}>\s?/gm, '')
        // The separator row of a table, then the pipes of every other row. Dropping the row
        // outright rather than its dashes: "--- --- ---" is not a summary of anything.
        .replace(/^\s{0,3}\|?[\s:|-]*-[\s:|-]*\|?\s*$/gm, ' ')
        .replace(/^\s{0,3}\|(.*)\|\s*$/gm, (_, row: string) => row.replace(/\s*\|\s*/g, ' '))
        .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '')
        // The checkbox is left behind by the list-marker rule above, which only takes the dash.
        .replace(/^\s{0,3}\[[ xX]?]\s+/gm, '')
        .replace(/^\s{0,3}([-*_])\s*(\1\s*){2,}$/gm, ' ')
        .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
        .replace(/<[^>\n]*>/g, ' ')
        .replace(/\\([|*_~[\]])/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();

    if (text.length <= max) return text;
    // Cut on a word boundary where there is one nearby, so the snippet does not end mid-word.
    const cut = text.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > max - 24 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
