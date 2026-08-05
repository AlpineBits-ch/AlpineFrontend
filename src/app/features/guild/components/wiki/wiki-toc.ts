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
