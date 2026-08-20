import {WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {parseWikiTarget, WIKI_LINK_PROTOCOL} from '../wiki-links';
import {USER_LINK_PROTOCOL} from './wiki-mention-menu.component';

/**
 * What a click on an anchor inside the article should do.
 *
 * Every href gets a verdict, including the ones nothing here recognises: an anchor left to default
 * behaviour reaches the WebView, and Tauri hands that to the system browser, or worse navigates the
 * client away from itself.
 */

export type WikiAnchorTarget =
    | {kind: 'page'; pageId: string; headingId: string | null}
    | {kind: 'user'}
    | {kind: 'external'; href: string}
    /** A relative href naming no page in this wiki. A red link. */
    | {kind: 'broken'}
    /** Nothing to do, but still not the browser's business. */
    | {kind: 'ignore'};

/** Mirrors the Link extension's allowlist in `wiki-extensions.ts`, minus the two internal ones. */
const EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(['http', 'https', 'mailto']);

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * Not `slugifyName` from `wiki-slug.ts`: that one produces DNS labels, so it caps at 63 characters
 * and treats an underscore as illegal. A page title is neither, and `Getting_Started` is exactly
 * how MediaWiki spells a link to "Getting Started".
 */
export function slugifyPageName(name: string): string {
    return name
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

export function resolveWikiAnchor(
    href: string | null | undefined,
    pages: readonly WikiPageSummaryDto[],
): WikiAnchorTarget {
    const raw = href?.trim();
    if (!raw) return {kind: 'ignore'};

    const target = parseWikiTarget(raw);
    if (target) return {kind: 'page', pageId: target.pageId, headingId: target.headingId};

    const scheme = SCHEME_RE.exec(raw)?.[1].toLowerCase();
    if (scheme === WIKI_LINK_PROTOCOL) return {kind: 'ignore'};
    if (scheme === USER_LINK_PROTOCOL) return {kind: 'user'};
    if (scheme) return EXTERNAL_PROTOCOLS.has(scheme) ? {kind: 'external', href: raw} : {kind: 'ignore'};

    return resolveRelative(raw, pages);
}

/**
 * `[Getting Started](Getting-Started)`, which is what GitHub and MediaWiki wikis write and what
 * anything pasted or imported from one is full of.
 */
function resolveRelative(raw: string, pages: readonly WikiPageSummaryDto[]): WikiAnchorTarget {
    const hash = raw.indexOf('#');
    const path = hash < 0 ? raw : raw.slice(0, hash);
    const headingId = hash < 0 ? null : decode(raw.slice(hash + 1)) || null;
    // An anchor into the page already open names no page to navigate to.
    if (!path) return {kind: 'ignore'};

    const name = decode(path).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!name) return {kind: 'ignore'};

    const lowered = name.toLowerCase();
    const exact = pages.find(page => page.slug?.toLowerCase() === lowered);
    if (exact) return {kind: 'page', pageId: exact.id, headingId};

    const wanted = slugifyPageName(name);
    if (!wanted) return {kind: 'broken'};

    const bySlug = pages.find(page => slugifyPageName(page.slug ?? '') === wanted);
    if (bySlug) return {kind: 'page', pageId: bySlug.id, headingId};

    const byTitle = pages.find(page => slugifyPageName(page.title) === wanted);
    if (byTitle) return {kind: 'page', pageId: byTitle.id, headingId};

    return {kind: 'broken'};
}

/** A malformed escape is not a reason to throw out of a click handler. */
function decode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
