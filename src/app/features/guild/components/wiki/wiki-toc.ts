/**
 * Table of contents.
 *
 * Takes already-extracted headings rather than a ProseMirror document, so the interesting part -
 * slug stability and collision handling - is testable without an editor instance. The component
 * owns the two-line walk that produces the Heading list.
 */

export interface Heading {
    level: number;
    text: string;
}

export interface TocEntry {
    id: string;
    text: string;
    level: number;
}

/**
 * Namespaces the anchor so a heading called "Search" cannot claim the id of a real element
 * elsewhere in the app. The rendered document is not in its own document, only its own subtree.
 */
export const HEADING_ID_PREFIX = 'wiki-h-';

export const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

/** Anchors must survive a reload, so ids come from the text, never from a counter or random id. */
export function slugify(text: string): string {
    const slug = text
        .toLowerCase()
        // Apostrophes and quotes are dropped rather than treated as separators: "what's" is one
        // word, and splitting it into "what-s" reads as two.
        .replace(/['‘’"“”]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    // Emoji-only or non-Latin headings reduce to '', which would collide with every other
    // empty slug. 'section' plus the dedupe suffix below keeps them addressable.
    return slug || 'section';
}

export function buildToc(headings: readonly Heading[]): TocEntry[] {
    const seen = new Map<string, number>();
    return headings.map(heading => {
        const base = slugify(heading.text);
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        return {
            id: count === 1 ? base : `${base}-${count}`,
            text: heading.text,
            level: heading.level,
        };
    });
}

export function headingElementId(entryId: string): string {
    return HEADING_ID_PREFIX + entryId;
}

export function headingElementsIn(root: ParentNode | null | undefined): HTMLElement[] {
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
}

/**
 * Stamps the table of contents' ids onto the rendered headings, in document order.
 *
 * Position, not text, is what pairs an entry with an element - `buildToc` emits in document order,
 * so the Nth entry belongs to the Nth heading. Matching on the slug instead would put both of two
 * headings called "Notes" on the first one, which is the whole reason the ids are deduplicated.
 *
 * ProseMirror owns this DOM and rebuilds nodes as the document changes, so ids do not survive an
 * edit; the caller re-applies after every update rather than assuming one pass is enough.
 * Returns how many headings were stamped, so a caller can tell a stale document from a matched one.
 */
export function applyHeadingIds(root: ParentNode | null | undefined, entries: readonly TocEntry[]): number {
    const elements = headingElementsIn(root);
    const paired = Math.min(elements.length, entries.length);
    for (let i = 0; i < paired; i++) {
        const id = headingElementId(entries[i].id);
        if (elements[i].id !== id) elements[i].id = id;
    }
    // A heading that lost its entry keeps answering to an anchor that has since moved elsewhere,
    // so ids this function set are cleared again rather than left behind.
    for (let i = paired; i < elements.length; i++) {
        if (elements[i].id.startsWith(HEADING_ID_PREFIX)) elements[i].removeAttribute('id');
    }
    return paired;
}

/**
 * Which heading the reader is currently under, from each heading's distance above the fold.
 *
 * Takes offsets rather than elements so the rule - the last heading whose top has passed the
 * reading line - is testable without a scroll container. Anything above the first heading still
 * reports the first: "no section" is not a useful answer while a document is on screen.
 */
export function activeHeadingIndex(offsets: readonly number[], line: number): number {
    if (!offsets.length) return -1;
    let active = 0;
    for (let i = 0; i < offsets.length; i++) {
        if (offsets[i] > line) break;
        active = i;
    }
    return active;
}
