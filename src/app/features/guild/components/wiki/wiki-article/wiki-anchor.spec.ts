import {WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {resolveWikiAnchor, slugifyPageName} from './wiki-anchor';

function page(id: string, title: string, slug: string): WikiPageSummaryDto {
    return {
        id,
        guildId: 'g1',
        title,
        slug,
        authorId: 'u1',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        visibility: 'public',
        tags: [],
        isPinned: false,
        revisionCount: 1,
    };
}

const PAGES = [
    page('p1', 'Getting Started', 'getting-started'),
    page('p2', 'Café Solstråle', 'cafe-solstrale'),
    page('p3', 'On-call Rota', 'on_call_rota'),
];

describe('resolveWikiAnchor', () => {
    it('keeps wiki: links internal, fragment included', () => {
        expect(resolveWikiAnchor('wiki:p1', PAGES)).toEqual({
            kind: 'page',
            pageId: 'p1',
            headingId: null,
        });
        expect(resolveWikiAnchor('wiki:p1#setup', PAGES)).toEqual({
            kind: 'page',
            pageId: 'p1',
            headingId: 'setup',
        });
    });

    it('swallows a mention', () => {
        expect(resolveWikiAnchor('user:u42', PAGES)).toEqual({kind: 'user'});
    });

    // The bug: this used to escape with no preventDefault and open the system browser.
    it('resolves a relative href by exact slug', () => {
        expect(resolveWikiAnchor('getting-started', PAGES)).toEqual({
            kind: 'page',
            pageId: 'p1',
            headingId: null,
        });
    });

    it('resolves a title written with hyphens, and one written with spaces', () => {
        expect(resolveWikiAnchor('Getting-Started', PAGES)).toMatchObject({pageId: 'p1'});
        expect(resolveWikiAnchor('Getting Started', PAGES)).toMatchObject({pageId: 'p1'});
    });

    it('matches case-insensitively', () => {
        expect(resolveWikiAnchor('GETTING-STARTED', PAGES)).toMatchObject({pageId: 'p1'});
    });

    it('decodes percent escapes before matching', () => {
        expect(resolveWikiAnchor('Getting%20Started', PAGES)).toMatchObject({pageId: 'p1'});
        expect(resolveWikiAnchor('Caf%C3%A9%20Solstr%C3%A5le', PAGES)).toMatchObject({pageId: 'p2'});
    });

    it('keeps a fragment on a relative href as the heading target', () => {
        expect(resolveWikiAnchor('Getting-Started#prerequisites', PAGES)).toEqual({
            kind: 'page',
            pageId: 'p1',
            headingId: 'prerequisites',
        });
    });

    it('strips a leading ./', () => {
        expect(resolveWikiAnchor('./Getting-Started', PAGES)).toMatchObject({pageId: 'p1'});
    });

    // MediaWiki spells a link to "On-call Rota" with underscores, and the DNS slug helper drops them.
    it('treats underscores as word separators', () => {
        expect(resolveWikiAnchor('On_call_Rota', PAGES)).toMatchObject({pageId: 'p3'});
    });

    it('calls a relative href that matches nothing broken, not external', () => {
        expect(resolveWikiAnchor('Nowhere-At-All', PAGES)).toEqual({kind: 'broken'});
    });

    it('classifies the three external schemes as external', () => {
        expect(resolveWikiAnchor('https://example.com/a', PAGES)).toEqual({
            kind: 'external',
            href: 'https://example.com/a',
        });
        expect(resolveWikiAnchor('http://example.com', PAGES)).toMatchObject({kind: 'external'});
        expect(resolveWikiAnchor('mailto:a@example.com', PAGES)).toMatchObject({kind: 'external'});
    });

    it('ignores a scheme outside the allowlist', () => {
        expect(resolveWikiAnchor('javascript:alert(1)', PAGES)).toEqual({kind: 'ignore'});
        expect(resolveWikiAnchor('file:///etc/passwd', PAGES)).toEqual({kind: 'ignore'});
    });

    it('ignores an empty, missing or same-page href', () => {
        expect(resolveWikiAnchor(null, PAGES)).toEqual({kind: 'ignore'});
        expect(resolveWikiAnchor('', PAGES)).toEqual({kind: 'ignore'});
        expect(resolveWikiAnchor('   ', PAGES)).toEqual({kind: 'ignore'});
        expect(resolveWikiAnchor('#overview', PAGES)).toEqual({kind: 'ignore'});
    });

    it('survives a malformed percent escape rather than throwing out of a click handler', () => {
        expect(resolveWikiAnchor('%E0%A4%A', PAGES)).toEqual({kind: 'broken'});
    });
});

describe('slugifyPageName', () => {
    it('folds diacritics rather than dropping them', () => {
        expect(slugifyPageName('Café Solstråle')).toBe('cafe-solstrale');
    });

    it('keeps a long title whole, unlike the DNS label helper', () => {
        const long = 'a'.repeat(80);
        expect(slugifyPageName(long)).toHaveLength(80);
    });
});
