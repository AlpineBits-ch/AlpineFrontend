import {
    buildBacklinkIndex,
    extractLinkedPageIds,
    findPlainOccurrences,
    findUnlinkedMentions,
    linkFirstMention,
    maskNonProse,
    parseWikiHref,
    parseWikiTarget,
    wikiHref,
} from './wiki-links';

describe('wikiHref / parseWikiHref', () => {
    it('round-trips a page id', () => {
        expect(parseWikiHref(wikiHref('abc123'))).toBe('abc123');
    });

    it('ignores ordinary links', () => {
        expect(parseWikiHref('https://example.com')).toBeNull();
    });

    // A stored page could carry a null or absent href; treating that as a wiki link would
    // render every such link as broken.
    it('ignores null and undefined', () => {
        expect(parseWikiHref(null)).toBeNull();
        expect(parseWikiHref(undefined)).toBeNull();
    });

    it('ignores an empty wiki href with no id', () => {
        expect(parseWikiHref('wiki:')).toBeNull();
    });

    it('does not match a protocol that merely starts with wiki', () => {
        expect(parseWikiHref('wikipedia:Foo')).toBeNull();
    });

    // Every existing caller wants a page id; a link to a section of that page is still a link to
    // it, so the fragment is stripped here rather than at each call site.
    it('strips a heading fragment from the page id', () => {
        expect(parseWikiHref('wiki:abc123#overview-2')).toBe('abc123');
    });
});

describe('parseWikiTarget', () => {
    it('round-trips a page and a section', () => {
        expect(parseWikiTarget(wikiHref('abc', 'overview-2'))).toEqual({
            pageId: 'abc',
            headingId: 'overview-2',
        });
    });

    it('reports no section for a plain page link', () => {
        expect(parseWikiTarget('wiki:abc')).toEqual({pageId: 'abc', headingId: null});
    });

    it('rejects a fragment with no page in front of it', () => {
        expect(parseWikiTarget('wiki:#overview')).toBeNull();
    });

    it('treats an empty fragment as no section', () => {
        expect(parseWikiTarget('wiki:abc#')).toEqual({pageId: 'abc', headingId: null});
    });
});

describe('extractLinkedPageIds', () => {
    it('finds a single markdown wiki link', () => {
        expect(extractLinkedPageIds('see [Setup](wiki:p1) for details')).toEqual(['p1']);
    });

    it('finds several links and de-duplicates repeats', () => {
        const md = '[A](wiki:p1) and [B](wiki:p2) and [A again](wiki:p1)';
        expect(extractLinkedPageIds(md).sort()).toEqual(['p1', 'p2']);
    });

    it('ignores ordinary markdown links', () => {
        expect(extractLinkedPageIds('[docs](https://example.com)')).toEqual([]);
    });

    it('returns nothing for empty content', () => {
        expect(extractLinkedPageIds('')).toEqual([]);
    });

    it('handles a link whose label contains brackets', () => {
        expect(extractLinkedPageIds('[a [nested] label](wiki:p9)')).toEqual(['p9']);
    });

    // A link to a section still links the page, so backlinks have to count it.
    it('counts a link to a section of a page as a link to that page', () => {
        expect(extractLinkedPageIds('[Setup](wiki:p1#install)')).toEqual(['p1']);
    });
});

describe('buildBacklinkIndex', () => {
    it('maps each target to the pages that link to it', () => {
        const index = buildBacklinkIndex(
            new Map([
                ['home', 'go to [Setup](wiki:setup)'],
                ['guide', 'also [Setup](wiki:setup) and [API](wiki:api)'],
                ['setup', 'no links here'],
            ]),
        );
        expect(index.get('setup')?.sort()).toEqual(['guide', 'home']);
        expect(index.get('api')).toEqual(['guide']);
    });

    it('omits targets nothing links to', () => {
        expect(buildBacklinkIndex(new Map([['a', 'plain text']])).size).toBe(0);
    });

    // Otherwise a page that references itself claims a backlink from itself, which reads as
    // "1 page links here" on a page nothing links to.
    it('does not record a page as its own backlink', () => {
        const index = buildBacklinkIndex(new Map([['a', 'see [me](wiki:a)']]));
        expect(index.get('a')).toBeUndefined();
    });
});

describe('maskNonProse', () => {
    // Length preservation is what makes an offset found in the mask usable against the original.
    it('keeps the masked copy exactly as long as the original', () => {
        const md = 'a `code` [link](wiki:p1)\n```\nfenced\n```\nhttps://example.com/setup';
        expect(maskNonProse(md)).toHaveLength(md.length);
    });

    it('keeps line structure so offsets stay readable', () => {
        expect(maskNonProse('```\nx\n```').split('\n')).toHaveLength(3);
    });

    it('leaves ordinary prose untouched', () => {
        expect(maskNonProse('Just some prose.')).toBe('Just some prose.');
    });

    // Brackets that open no link are punctuation, and swallowing the rest of the line would hide
    // every mention after them.
    it('does not mask brackets that are not a link', () => {
        expect(maskNonProse('see [note] Setup')).toContain('Setup');
    });
});

describe('findPlainOccurrences', () => {
    it('finds a plain mention regardless of case', () => {
        expect(findPlainOccurrences('The setup is done', 'Setup')).toEqual([4]);
    });

    it('matches whole words only', () => {
        expect(findPlainOccurrences('resetups and setupper', 'Setup')).toEqual([]);
    });

    it('allows punctuation on either side', () => {
        expect(findPlainOccurrences('(Setup), yes', 'Setup')).toEqual([1]);
    });

    it('finds every occurrence', () => {
        expect(findPlainOccurrences('Setup then setup', 'Setup')).toEqual([0, 11]);
    });

    it('ignores a mention that is already a link', () => {
        expect(findPlainOccurrences('see [Setup](wiki:p1) now', 'Setup')).toEqual([]);
    });

    it('ignores a mention inside a link target', () => {
        expect(findPlainOccurrences('see [docs](https://x.dev/Setup)', 'Setup')).toEqual([]);
    });

    it('ignores a mention inside a fenced code block', () => {
        expect(findPlainOccurrences('```\nSetup()\n```', 'Setup')).toEqual([]);
    });

    it('ignores a mention inside a tilde fence', () => {
        expect(findPlainOccurrences('~~~\nSetup\n~~~', 'Setup')).toEqual([]);
    });

    // A fence somebody forgot to close still reads as code to the end of the page.
    it('ignores everything after an unterminated fence', () => {
        expect(findPlainOccurrences('```\nSetup\nmore Setup', 'Setup')).toEqual([]);
    });

    it('ignores a mention inside a code span', () => {
        expect(findPlainOccurrences('call `Setup` first', 'Setup')).toEqual([]);
    });

    it('ignores a mention inside a bare url', () => {
        expect(findPlainOccurrences('https://example.com/Setup here', 'Setup')).toEqual([]);
    });

    it('still finds prose on a line that also holds a link', () => {
        expect(findPlainOccurrences('[docs](wiki:p2) explain Setup well', 'Setup')).toEqual([24]);
    });

    it('finds a multi-word title', () => {
        expect(findPlainOccurrences('read the Getting Started guide', 'Getting Started')).toEqual([9]);
    });

    // Titles are not regexes, and a wiki full of "C++" or "What's new?" pages would otherwise
    // throw or match the wrong thing.
    it('treats regex metacharacters in the title literally', () => {
        expect(findPlainOccurrences('we use C++ here', 'C++')).toEqual([7]);
        expect(findPlainOccurrences('we use Cxx here', 'C++')).toEqual([]);
    });

    it('finds nothing for a blank title', () => {
        expect(findPlainOccurrences('anything at all', '   ')).toEqual([]);
    });
});

describe('findUnlinkedMentions', () => {
    const target = {id: 'setup', title: 'Setup'};

    it('reports pages that name the title without linking it', () => {
        const found = findUnlinkedMentions(
            target,
            new Map([
                ['guide', 'run Setup before anything else'],
                ['other', 'nothing relevant here'],
            ]),
        );
        expect(found).toEqual([{sourceId: 'guide', index: 4, text: 'Setup', count: 1}]);
    });

    // Otherwise the same page is reported twice on the same rail, once under each heading.
    it('skips pages that already link the target', () => {
        expect(
            findUnlinkedMentions(target, new Map([['guide', 'see [Setup](wiki:setup) and Setup again']])),
        ).toEqual([]);
    });

    // A page naming its own title is not a link it forgot to make.
    it('skips the target page itself', () => {
        expect(findUnlinkedMentions(target, new Map([['setup', 'Setup is this page']]))).toEqual([]);
    });

    it('keeps the casing the source page actually used', () => {
        expect(findUnlinkedMentions(target, new Map([['guide', 'the SETUP step']]))[0].text).toBe('SETUP');
    });

    it('counts repeated mentions on one page once, with a total', () => {
        const found = findUnlinkedMentions(target, new Map([['guide', 'Setup, then Setup']]));
        expect(found).toHaveLength(1);
        expect(found[0].count).toBe(2);
    });

    it('finds nothing for an untitled page', () => {
        expect(findUnlinkedMentions({id: 'x', title: ' '}, new Map([['g', 'anything']]))).toEqual([]);
    });
});

describe('linkFirstMention', () => {
    it('links the first mention and leaves the rest of the body alone', () => {
        expect(linkFirstMention('run Setup then Setup again', 'Setup', 'p1')).toBe(
            'run [Setup](wiki:p1) then Setup again',
        );
    });

    it('keeps the casing that was there', () => {
        expect(linkFirstMention('run SETUP now', 'Setup', 'p1')).toBe('run [SETUP](wiki:p1) now');
    });

    it('skips a mention that only appears inside code', () => {
        expect(linkFirstMention('`Setup`', 'Setup', 'p1')).toBeNull();
    });

    it('reports nothing to do when the page never mentions the title', () => {
        expect(linkFirstMention('unrelated prose', 'Setup', 'p1')).toBeNull();
    });

    // A bracket in the title would close the link label early and produce markdown that means
    // something else entirely.
    it('refuses a title containing brackets rather than writing broken markdown', () => {
        expect(linkFirstMention('the [draft] page', '[draft]', 'p1')).toBeNull();
    });

    it('places the link at the right offset after an emoji', () => {
        expect(linkFirstMention('🎉 Setup', 'Setup', 'p1')).toBe('🎉 [Setup](wiki:p1)');
    });
});
