/**
 * Wiki page links, as they travel through chat.
 *
 * <p>The wiki's own internal links are `wiki:<pageId>` (see `wiki-links.ts`). That form resolves
 * only inside the editor: it carries no guild, and no scheme a pasted string survives. A link in a
 * message has to survive copy, paste, and a click from somebody standing in a different guild, so
 * chat uses an absolute URL shaped exactly like the invite links that already travel this way -
 * `https://venta.gg/invite/<code>`. Same host, same "the client recognises it and handles it
 * itself" contract, one card renderer pattern rather than two.</p>
 *
 * <p>Deliberately not an app route. `app.routes.ts` has two routes - `/authentication` and
 * `/overview` - and the wiki is a `mainView` inside the latter, not a route of its own. A route
 * shaped link would name a place the router cannot reach, and the desktop shell would hand it to
 * the browser anyway.</p>
 */

/** Where a shared page id is turned back into a place: `/wiki/<guildId>/<pageId>`. */
const WIKI_URL_SOURCE =
    'https:\\/\\/venta\\.gg\\/wiki\\/([A-Za-z0-9_-]+)\\/([A-Za-z0-9_-]+)(?:\\/[^\\s<>]*)?';

/**
 * A fresh regex per call rather than one shared instance.
 *
 * <p>A `g` regex carries `lastIndex` between calls, and this one is used from a `computed` that
 * reruns on every profile that resolves - a shared instance drops matches at random.</p>
 */
export function wikiUrlPattern(): RegExp {
    return new RegExp(WIKI_URL_SOURCE, 'g');
}

/** The whole string is one wiki link and nothing else. */
export function parseWikiUrl(text: string): { guildId: string; pageId: string } | null {
    const match = new RegExp(`^${WIKI_URL_SOURCE}$`).exec(text.trim());
    return match ? {guildId: match[1], pageId: match[2]} : null;
}

/**
 * The link to put in a message.
 *
 * <p>Wrapped in angle brackets, which is how a sender opts out of a server-side preview and is what
 * the server reads. The client renders its own card from the same URL, so an unfurl would either
 * duplicate that card or - since `venta.gg/wiki/...` is not a page a crawler can read - attach a
 * broken one. `MessageComponent.displayContent` strips the brackets before anything is rendered,
 * so a person never sees them.</p>
 */
export function wikiShareLink(guildId: string, pageId: string): string {
    return `<${wikiUrl(guildId, pageId)}>`;
}

/** The bare URL, for "copy link" and for anything that does its own bracketing. */
export function wikiUrl(guildId: string, pageId: string): string {
    return `https://venta.gg/wiki/${guildId}/${pageId}`;
}

/**
 * A plain-text preview of a page body, for the card.
 *
 * <p>Markdown is stripped rather than rendered: the card is a two-line summary inside somebody
 * else's message, and running a wiki body through the message markdown pipe would let a page
 * resolve to an image or a link inside a conversation it was never posted to.</p>
 */
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
