import {WikiDto} from '../../../../../dtos/response/wiki.dto';
import {buildTrail} from './wiki-trail';

function wiki(over: Partial<WikiDto> = {}): WikiDto {
    return {id: 'w', guildId: 'g', categories: [], pages: [], ...over} as WikiDto;
}

const page = (id: string, title: string, extra: Record<string, unknown> = {}) =>
    ({
        id, title, guildId: 'g', slug: id, authorId: 'u',
        createdAt: new Date(), updatedAt: new Date(),
        visibility: 'public', tags: [], isPinned: false, revisionCount: 0, ...extra,
    }) as never;

describe('buildTrail', () => {
    it('returns nothing when no page is selected', () => {
        expect(buildTrail(wiki(), null)).toEqual([]);
    });

    it('returns just the page for a root page with no category', () => {
        const w = wiki({pages: [page('p1', 'Setup')]});
        expect(buildTrail(w, 'p1')).toEqual([{id: 'p1', label: 'Setup', kind: 'page'}]);
    });

    it('puts the category before the page', () => {
        const w = wiki({
            categories: [{id: 'c1', guildId: 'g', name: 'Guides', position: 0}],
            pages: [page('p1', 'Setup', {categoryId: 'c1'})],
        });
        expect(buildTrail(w, 'p1')).toEqual([
            {id: 'c1', label: 'Guides', kind: 'category'},
            {id: 'p1', label: 'Setup', kind: 'page'},
        ]);
    });

    it('walks ancestor pages outermost first', () => {
        const w = wiki({
            pages: [
                page('root', 'Root'),
                page('mid', 'Mid', {parentPageId: 'root'}),
                page('leaf', 'Leaf', {parentPageId: 'mid'}),
            ],
        });
        expect(buildTrail(w, 'leaf').map(s => s.label)).toEqual(['Root', 'Mid', 'Leaf']);
    });

    // Cyclic parent data exists in the wild - the nav already guards against it. An unguarded
    // walk here would hang the render.
    it('terminates on a parent cycle', () => {
        const w = wiki({
            pages: [page('a', 'A', {parentPageId: 'b'}), page('b', 'B', {parentPageId: 'a'})],
        });
        expect(buildTrail(w, 'a').length).toBeLessThanOrEqual(2);
    });

    it('terminates on a page that is its own parent', () => {
        const w = wiki({pages: [page('a', 'A', {parentPageId: 'a'})]});
        expect(buildTrail(w, 'a')).toEqual([{id: 'a', label: 'A', kind: 'page'}]);
    });

    it('returns nothing for an unknown page id', () => {
        expect(buildTrail(wiki({pages: [page('p1', 'Setup')]}), 'nope')).toEqual([]);
    });
});
