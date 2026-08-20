import {buildToc, Heading} from '../wiki-toc';

/**
 * The two pure halves of the link picker: which sections a stored page offers as link targets,
 * and what a typed href has to become before it is worth writing into the document.
 */

export interface MarkdownHeading {
    /** A `wiki-toc` entry id, which is what `wikiHref`'s second argument takes. */
    id: string;
    text: string;
    level: number;
}

/** Only fences are skipped; `maskNonProse` would also blank the link text a heading can contain. */
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const ATX_RE = /^[ \t]{0,3}(#{1,6})[ \t]+(.*)$/;

export function headingsFromMarkdown(markdown: string): MarkdownHeading[] {
    const headings: Heading[] = [];
    let fence: string | null = null;

    for (const line of markdown.split('\n')) {
        const fenceMatch = FENCE_RE.exec(line);
        if (fence) {
            if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
                fence = null;
            }
            continue;
        }
        if (fenceMatch) {
            fence = fenceMatch[1];
            continue;
        }
        const atx = ATX_RE.exec(line);
        if (!atx) continue;
        const text = plainText(atx[2]);
        if (text) headings.push({level: atx[1].length, text});
    }

    // Through buildToc so the ids match what the table of contents stamped on the rendered page.
    return buildToc(headings).map(entry => ({id: entry.id, text: entry.text, level: entry.level}));
}

/** Strips the inline markup a heading carries, so the picker shows what the reader sees. */
function plainText(raw: string): string {
    return raw
        .replace(/[ \t]+#+[ \t]*$/, '')
        .replace(/!?\[([^\]]*)]\([^)]*\)/g, '$1')
        .replace(/[*_~`]/g, '')
        .trim();
}

/** Mirrors the Link extension's allowlist in `wiki-extensions.ts`, minus the two internal ones. */
export const WIKI_EXTERNAL_PROTOCOLS: readonly string[] = ['http', 'https', 'mailto'];

export type ExternalHrefStatus = 'ok' | 'scheme-added' | 'blocked';

export interface NormalisedHref {
    href: string;
    status: ExternalHrefStatus;
}

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * What `setLink` should be handed for a typed href.
 *
 * `example.com` is the case that matters: left alone it is a relative link the browser resolves
 * against the app's own origin, and no reader ever reaches the site they meant.
 */
export function normaliseExternalHref(input: string): NormalisedHref {
    const text = input.trim();
    if (!text) return {href: '', status: 'blocked'};

    const scheme = SCHEME_RE.exec(text);
    if (scheme) {
        const allowed = WIKI_EXTERNAL_PROTOCOLS.includes(scheme[1].toLowerCase());
        return {href: allowed ? text : '', status: allowed ? 'ok' : 'blocked'};
    }
    // Protocol-relative and root-relative both resolve against the app's own origin, which is a
    // Tauri asset URL and never the site the author meant.
    if (text.startsWith('//')) return {href: `https:${text}`, status: 'scheme-added'};
    if (text.startsWith('/') || text.startsWith('#')) return {href: '', status: 'blocked'};
    if (EMAIL_RE.test(text)) return {href: `mailto:${text}`, status: 'scheme-added'};
    if (/\s/.test(text)) return {href: '', status: 'blocked'};
    return {href: `https://${text}`, status: 'scheme-added'};
}
