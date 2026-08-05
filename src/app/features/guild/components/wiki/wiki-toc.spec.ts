import {buildToc, slugify} from './wiki-toc';

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
        expect(buildToc([{level: 1, text: 'Intro'}, {level: 2, text: 'Details'}])).toEqual([
            {id: 'intro', text: 'Intro', level: 1},
            {id: 'details', text: 'Details', level: 2},
        ]);
    });

    // Two "Notes" headings are common. Without suffixing, both anchors point at the first.
    it('suffixes duplicate slugs so every id is unique', () => {
        expect(buildToc([
            {level: 2, text: 'Notes'},
            {level: 2, text: 'Notes'},
            {level: 2, text: 'Notes'},
        ]).map(e => e.id)).toEqual(['notes', 'notes-2', 'notes-3']);
    });

    it('returns nothing for a document with no headings', () => {
        expect(buildToc([])).toEqual([]);
    });

    it('preserves the original heading text including punctuation', () => {
        expect(buildToc([{level: 3, text: "What's new?"}])[0].text).toBe("What's new?");
    });
});
