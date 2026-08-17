import {
    activeHeadingIndex,
    applyHeadingIds,
    buildToc,
    headingElementId,
    headingElementsIn,
    slugify,
} from './wiki-toc';

describe('slugify', () => {
    it('lowercases and hyphenates words', () => {
        expect(slugify('Getting Started')).toBe('getting-started');
    });

    it('strips punctuation', () => {
        expect(slugify("What's new?")).toBe('whats-new');
    });

    it('collapses runs of separators and trims the ends', () => {
        expect(slugify('  a --  b  ')).toBe('a-b');
    });

    // Headings can be pure emoji or CJK; an empty id would collide with every other empty id
    // and make anchors unusable.
    it('falls back to a stable placeholder when nothing survives', () => {
        expect(slugify('🎉')).toBe('section');
    });

    it('keeps digits', () => {
        expect(slugify('Step 2')).toBe('step-2');
    });
});

describe('buildToc', () => {
    it('assigns a slug id per heading', () => {
        expect(
            buildToc([
                {level: 1, text: 'Intro'},
                {level: 2, text: 'Details'},
            ]),
        ).toEqual([
            {id: 'intro', text: 'Intro', level: 1},
            {id: 'details', text: 'Details', level: 2},
        ]);
    });

    // Two "Notes" headings are common. Without suffixing, both anchors point at the first.
    it('suffixes duplicate slugs so every id is unique', () => {
        expect(
            buildToc([
                {level: 2, text: 'Notes'},
                {level: 2, text: 'Notes'},
                {level: 2, text: 'Notes'},
            ]).map(e => e.id),
        ).toEqual(['notes', 'notes-2', 'notes-3']);
    });

    it('returns nothing for a document with no headings', () => {
        expect(buildToc([])).toEqual([]);
    });

    it('preserves the original heading text including punctuation', () => {
        expect(buildToc([{level: 3, text: "What's new?"}])[0].text).toBe("What's new?");
    });

    // Two headings with the same text must not share an id, or a link to the second one lands on
    // the first. Dedupe has to be positional, not random, or the anchor changes on every render.
    it('produces the same ids for the same document twice', () => {
        const headings = [
            {level: 2, text: 'Overview'},
            {level: 3, text: 'Overview'},
            {level: 2, text: 'Overview'},
        ];
        expect(buildToc(headings).map(e => e.id)).toEqual(buildToc(headings).map(e => e.id));
        expect(buildToc(headings).map(e => e.id)).toEqual(['overview', 'overview-2', 'overview-3']);
    });
});

function body(html: string): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = html;
    return root;
}

describe('applyHeadingIds', () => {
    it('stamps the toc ids onto the rendered headings in document order', () => {
        const root = body('<h1>Intro</h1><p>x</p><h2>Details</h2>');
        const stamped = applyHeadingIds(
            root,
            buildToc([
                {level: 1, text: 'Intro'},
                {level: 2, text: 'Details'},
            ]),
        );
        expect(stamped).toBe(2);
        expect(headingElementsIn(root).map(el => el.id)).toEqual(['wiki-h-intro', 'wiki-h-details']);
    });

    // Position, not text: matching on the slug would put both "Notes" ids on the first heading.
    it('gives duplicate headings the distinct ids the toc assigned them', () => {
        const root = body('<h2>Notes</h2><h2>Notes</h2>');
        applyHeadingIds(
            root,
            buildToc([
                {level: 2, text: 'Notes'},
                {level: 2, text: 'Notes'},
            ]),
        );
        expect(headingElementsIn(root).map(el => el.id)).toEqual(['wiki-h-notes', 'wiki-h-notes-2']);
    });

    // ProseMirror rebuilds nodes as the document changes, so this runs repeatedly on the same DOM.
    it('is idempotent', () => {
        const root = body('<h2>Notes</h2>');
        const entries = buildToc([{level: 2, text: 'Notes'}]);
        applyHeadingIds(root, entries);
        applyHeadingIds(root, entries);
        expect(headingElementsIn(root)[0].id).toBe('wiki-h-notes');
    });

    // A heading whose entry is gone would otherwise keep answering to an anchor that has moved.
    it('clears ids it set from headings the toc no longer covers', () => {
        const root = body('<h2>Notes</h2><h2>Extra</h2>');
        applyHeadingIds(
            root,
            buildToc([
                {level: 2, text: 'Notes'},
                {level: 2, text: 'Extra'},
            ]),
        );
        applyHeadingIds(root, buildToc([{level: 2, text: 'Notes'}]));
        expect(headingElementsIn(root).map(el => el.id)).toEqual(['wiki-h-notes', '']);
    });

    it('leaves ids it did not set alone', () => {
        const root = body('<h2 id="mine">Notes</h2><h2>Extra</h2>');
        applyHeadingIds(root, []);
        expect(headingElementsIn(root)[0].id).toBe('mine');
    });

    it('survives a missing root', () => {
        expect(applyHeadingIds(null, buildToc([{level: 1, text: 'Intro'}]))).toBe(0);
    });

    it('namespaces the element id so it cannot collide with the rest of the app', () => {
        expect(headingElementId('search')).toBe('wiki-h-search');
    });
});

describe('activeHeadingIndex', () => {
    it('picks the last heading that has passed the reading line', () => {
        expect(activeHeadingIndex([-120, -20, 300, 800], 0)).toBe(1);
    });

    // Scrolled above the first heading there is still a section on screen; reporting none would
    // blank the highlight for the whole intro of every page.
    it('falls back to the first heading while above all of them', () => {
        expect(activeHeadingIndex([40, 300, 800], 0)).toBe(0);
    });

    it('reports the last heading once everything has scrolled past', () => {
        expect(activeHeadingIndex([-900, -600, -100], 0)).toBe(2);
    });

    it('has no answer for a document with no headings', () => {
        expect(activeHeadingIndex([], 0)).toBe(-1);
    });
});
