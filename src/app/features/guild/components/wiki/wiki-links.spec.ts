import {buildBacklinkIndex, extractLinkedPageIds, parseWikiHref, wikiHref} from './wiki-links';

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
});

describe('buildBacklinkIndex', () => {
    it('maps each target to the pages that link to it', () => {
        const index = buildBacklinkIndex(new Map([
            ['home', 'go to [Setup](wiki:setup)'],
            ['guide', 'also [Setup](wiki:setup) and [API](wiki:api)'],
            ['setup', 'no links here'],
        ]));
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
