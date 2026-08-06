import {matchesFilters, PathCategory, PathPage, SearchCandidate, searchWiki, wikiPagePath} from './wiki-search';

function candidate(over: Partial<SearchCandidate> & { id: string }): SearchCandidate {
    return {title: over.id, tags: [], ...over};
}

describe('searchWiki', () => {
    it('returns nothing for an empty or whitespace query', () => {
        const items = [candidate({id: 'a', title: 'Alpha'})];
        expect(searchWiki(items, '')).toEqual([]);
        expect(searchWiki(items, '   ')).toEqual([]);
    });

    it('ranks an exact title above a prefix match', () => {
        const hits = searchWiki([
            candidate({id: 'p', title: 'Setup Guide'}),
            candidate({id: 'e', title: 'Setup'}),
        ], 'Setup');
        expect(hits.map(h => h.id)).toEqual(['e', 'p']);
    });

    it('ranks a title prefix above a mid-word substring', () => {
        const hits = searchWiki([
            candidate({id: 'sub', title: 'Advanced Setup'}),
            candidate({id: 'pre', title: 'Setup Notes'}),
        ], 'setup');
        expect(hits[0].id).toBe('pre');
    });

    it('ranks a title match above a tag match', () => {
        const hits = searchWiki([
            candidate({id: 'tag', title: 'Unrelated', tags: ['deploy']}),
            candidate({id: 'title', title: 'Deploy'}),
        ], 'deploy');
        expect(hits[0].id).toBe('title');
    });

    it('ranks a tag match above a content-only match', () => {
        const hits = searchWiki([
            candidate({id: 'body', title: 'Unrelated', content: 'we deploy on fridays'}),
            candidate({id: 'tag', title: 'Unrelated Too', tags: ['deploy']}),
        ], 'deploy');
        expect(hits[0].id).toBe('tag');
    });

    it('is case insensitive', () => {
        expect(searchWiki([candidate({id: 'a', title: 'Setup'})], 'SETUP')).toHaveLength(1);
    });

    it('reports which field matched', () => {
        expect(searchWiki([candidate({id: 'a', title: 'Setup'})], 'setup')[0].matchedIn).toBe('title');
        expect(searchWiki([candidate({id: 'b', title: 'X', tags: ['setup']})], 'setup')[0].matchedIn).toBe('tag');
    });

    it('returns a snippet around a content match and none for a title match', () => {
        const hits = searchWiki([
            candidate({id: 'a', title: 'X', content: 'lorem ipsum deploy dolor sit'}),
        ], 'deploy');
        expect(hits[0].snippet).toContain('deploy');
        expect(searchWiki([candidate({id: 'b', title: 'Deploy'})], 'deploy')[0].snippet).toBeNull();
    });

    it('matches a subsequence in the title when no substring matches', () => {
        // 'stp' appears in order inside 'Setup' but not contiguously.
        expect(searchWiki([candidate({id: 'a', title: 'Setup'})], 'stp')).toHaveLength(1);
    });

    it('excludes candidates that match nothing', () => {
        expect(searchWiki([candidate({id: 'a', title: 'Setup'})], 'zzzz')).toEqual([]);
    });

    it('breaks ties deterministically by shorter title then alphabetically', () => {
        const hits = searchWiki([
            candidate({id: 'long', title: 'Setup Guide Extended'}),
            candidate({id: 'b', title: 'Setup B'}),
            candidate({id: 'a', title: 'Setup A'}),
        ], 'setup');
        expect(hits.map(h => h.id)).toEqual(['a', 'b', 'long']);
    });

    it('honours the result limit', () => {
        const many = Array.from({length: 50}, (_, i) => candidate({id: `p${i}`, title: `Setup ${i}`}));
        expect(searchWiki(many, 'setup', 10)).toHaveLength(10);
    });

    it('narrows to a tag before ranking', () => {
        const hits = searchWiki([
            candidate({id: 'a', title: 'Setup', tags: ['ops']}),
            candidate({id: 'b', title: 'Setup Guide', tags: ['design']}),
        ], 'setup', 25, {tag: 'ops'});
        expect(hits.map(h => h.id)).toEqual(['a']);
    });

    it('narrows to a category and an author', () => {
        const items = [
            candidate({id: 'a', title: 'Setup', categoryId: 'c1', authorId: 'u1'}),
            candidate({id: 'b', title: 'Setup', categoryId: 'c2', authorId: 'u1'}),
            candidate({id: 'c', title: 'Setup', categoryId: 'c1', authorId: 'u2'}),
        ];
        expect(searchWiki(items, 'setup', 25, {categoryId: 'c1'}).map(h => h.id).sort()).toEqual(['a', 'c']);
        expect(searchWiki(items, 'setup', 25, {authorId: 'u2'}).map(h => h.id)).toEqual(['c']);
    });

    // "Everything tagged deploy" is a question worth answering; answering it with nothing would
    // look like the filter was broken.
    it('lists every filtered page when the query is empty but a filter is set', () => {
        const hits = searchWiki([
            candidate({id: 'b', title: 'Beta', tags: ['ops']}),
            candidate({id: 'a', title: 'Alpha', tags: ['ops']}),
            candidate({id: 'x', title: 'Excluded', tags: ['other']}),
        ], '', 25, {tag: 'ops'});
        expect(hits.map(h => h.id)).toEqual(['a', 'b']);
    });

    it('still returns nothing for an empty query with no filters', () => {
        expect(searchWiki([candidate({id: 'a', title: 'Alpha'})], '', 25, {})).toEqual([]);
    });

    it('matches a tag filter case insensitively', () => {
        expect(matchesFilters(candidate({id: 'a', tags: ['Ops']}), {tag: 'ops'})).toBe(true);
    });

    it('treats an unset filter field as no constraint', () => {
        expect(matchesFilters(candidate({id: 'a'}), {})).toBe(true);
    });
});

describe('wikiPagePath', () => {
    const categories: PathCategory[] = [
        {id: 'top', name: 'Handbook'},
        {id: 'sub', name: 'Operations', parentCategoryId: 'top'},
    ];
    const pages: PathPage[] = [
        {id: 'root', title: 'Deploying', categoryId: 'sub'},
        {id: 'leaf', title: 'Rollback', parentPageId: 'root', categoryId: 'sub'},
        {id: 'loose', title: 'Scratch'},
    ];

    it('walks categories then page ancestors, outermost first', () => {
        expect(wikiPagePath('leaf', pages, categories))
            .toEqual(['Handbook', 'Operations', 'Deploying', 'Rollback']);
    });

    it('is just the title for a page with no category and no parent', () => {
        expect(wikiPagePath('loose', pages, categories)).toEqual(['Scratch']);
    });

    it('returns nothing for an unknown page', () => {
        expect(wikiPagePath('missing', pages, categories)).toEqual([]);
    });

    it('terminates on a page cycle', () => {
        const cyclic: PathPage[] = [
            {id: 'a', title: 'A', parentPageId: 'b'},
            {id: 'b', title: 'B', parentPageId: 'a'},
        ];
        expect(wikiPagePath('a', cyclic, [])).toEqual(['B', 'A']);
    });

    it('terminates on a category cycle', () => {
        const cyclic: PathCategory[] = [
            {id: 'x', name: 'X', parentCategoryId: 'y'},
            {id: 'y', name: 'Y', parentCategoryId: 'x'},
        ];
        expect(wikiPagePath('p', [{id: 'p', title: 'P', categoryId: 'x'}], cyclic))
            .toEqual(['Y', 'X', 'P']);
    });
});
