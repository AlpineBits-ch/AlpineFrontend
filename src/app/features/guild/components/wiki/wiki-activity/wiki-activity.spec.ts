import {buildWikiActivity, countContributors} from './wiki-activity';
import {WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';

function page(over: Partial<WikiPageSummaryDto> & { id: string }): WikiPageSummaryDto {
    return {
        guildId: 'g',
        title: over.id,
        slug: over.id,
        authorId: 'author',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        visibility: 'public',
        tags: [],
        isPinned: false,
        revisionCount: 0,
        ...over,
    };
}

describe('buildWikiActivity', () => {
    it('reports a creation for every page', () => {
        const feed = buildWikiActivity([page({id: 'a'}), page({id: 'b'})]);
        expect(feed.map(e => e.kind)).toEqual(['created', 'created']);
    });

    // Creation stamps both dates at once; a page that has never been edited must not claim it was.
    it('does not report an edit when updatedAt only trails createdAt by the write itself', () => {
        const feed = buildWikiActivity([page({
            id: 'a',
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-01T00:00:02Z'),
        })]);
        expect(feed.map(e => e.kind)).toEqual(['created']);
    });

    it('reports both a creation and an edit for a page edited later', () => {
        const feed = buildWikiActivity([page({
            id: 'a',
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-03T00:00:00Z'),
        })]);
        expect(feed.map(e => e.kind)).toEqual(['edited', 'created']);
    });

    it('credits an edit to the last editor, falling back to the author', () => {
        const [withEditor] = buildWikiActivity([page({
            id: 'a',
            lastEditorId: 'editor',
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-03T00:00:00Z'),
        })]);
        expect(withEditor.actorId).toBe('editor');

        const [withoutEditor] = buildWikiActivity([page({
            id: 'b',
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-03T00:00:00Z'),
        })]);
        expect(withoutEditor.actorId).toBe('author');
    });

    it('orders newest first across pages', () => {
        const feed = buildWikiActivity([
            page({id: 'old', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z')}),
            page({id: 'new', createdAt: new Date('2026-02-01T00:00:00Z'), updatedAt: new Date('2026-02-01T00:00:00Z')}),
        ]);
        expect(feed.map(e => e.page.id)).toEqual(['new', 'old']);
    });

    it('caps the feed at the requested limit', () => {
        const pages = Array.from({length: 10}, (_, i) => page({id: `p${i}`}));
        expect(buildWikiActivity(pages, 3).length).toBe(3);
    });

    it('accepts ISO strings, which is what actually comes over the wire', () => {
        const feed = buildWikiActivity([page({
            id: 'a',
            createdAt: '2026-01-01T00:00:00Z' as unknown as Date,
            updatedAt: '2026-01-01T00:00:00Z' as unknown as Date,
        })]);
        expect(feed[0].at).toBe(Date.parse('2026-01-01T00:00:00Z'));
    });

    it('skips a page whose dates cannot be parsed rather than sorting NaN into the middle', () => {
        const feed = buildWikiActivity([page({
            id: 'a',
            createdAt: 'not a date' as unknown as Date,
            updatedAt: 'not a date' as unknown as Date,
        })]);
        expect(feed).toEqual([]);
    });
});

describe('countContributors', () => {
    it('counts authors and last editors once each', () => {
        expect(countContributors([
            page({id: 'a', authorId: 'x', lastEditorId: 'y'}),
            page({id: 'b', authorId: 'x', lastEditorId: 'x'}),
        ])).toBe(2);
    });
});
