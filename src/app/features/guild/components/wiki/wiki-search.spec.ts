import {SearchCandidate, searchWiki} from './wiki-search';

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
});
