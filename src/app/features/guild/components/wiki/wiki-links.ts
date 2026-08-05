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

export function wikiHref(pageId: string): string {
    return `${WIKI_LINK_PROTOCOL}:${pageId}`;
}

export function parseWikiHref(href: string | null | undefined): string | null {
    if (!href) return null;
    const match = WIKI_HREF_RE.exec(href);
    return match ? match[1] : null;
}

export function extractLinkedPageIds(markdown: string): string[] {
    const ids = new Set<string>();
    for (const match of markdown.matchAll(MD_WIKI_LINK_RE)) {
        ids.add(match[1]);
    }
    return [...ids];
}

/**
 * Inverts "page -> pages it links to" into "page -> pages that link to it".
 *
 * Self-links are dropped: a page that references itself would otherwise report a backlink from
 * itself, which reads as "1 page links here" on a page nothing actually links to.
 */
export function buildBacklinkIndex(
    contentByPageId: ReadonlyMap<string, string>,
): Map<string, string[]> {
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
