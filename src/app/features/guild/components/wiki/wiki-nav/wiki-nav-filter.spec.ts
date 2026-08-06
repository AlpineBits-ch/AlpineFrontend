import {FilterableCategory, FilterablePage, narrowNav} from './wiki-nav-filter';

function category(over: Partial<FilterableCategory> & { id: string }): FilterableCategory {
    return {name: over.id, ...over};
}

function page(over: Partial<FilterablePage> & { id: string }): FilterablePage {
    return {title: over.id, tags: [], ...over};
}

describe('narrowNav', () => {
    it('returns null when there is no filter, so the caller can skip every lookup', () => {
        expect(narrowNav([], [page({id: 'a'})], '')).toBeNull();
        expect(narrowNav([], [page({id: 'a'})], '   ')).toBeNull();
    });

    it('keeps pages whose title matches, case insensitively', () => {
        const result = narrowNav([], [
            page({id: 'a', title: 'Deploying'}),
            page({id: 'b', title: 'Onboarding'}),
        ], 'DEPLOY');
        expect([...result!.pageIds]).toEqual(['a']);
    });

    it('keeps pages whose tag matches', () => {
        const result = narrowNav([], [page({id: 'a', title: 'Unrelated', tags: ['deploy']})], 'deploy');
        expect(result!.pageIds.has('a')).toBe(true);
    });

    // A nested hit whose parent row is hidden is unreachable - the tree would render it at the
    // top level or not at all.
    it('keeps the ancestors of a matching page', () => {
        const result = narrowNav([], [
            page({id: 'root', title: 'Guides'}),
            page({id: 'mid', title: 'Servers', parentPageId: 'root'}),
            page({id: 'leaf', title: 'Deploying', parentPageId: 'mid'}),
        ], 'deploy');
        expect([...result!.pageIds].sort()).toEqual(['leaf', 'mid', 'root']);
    });

    it('keeps the category a surviving page lives in', () => {
        const result = narrowNav(
            [category({id: 'c1', name: 'Operations'})],
            [page({id: 'a', title: 'Deploying', categoryId: 'c1'})],
            'deploy',
        );
        expect(result!.categoryIds.has('c1')).toBe(true);
    });

    it('keeps parent categories of a surviving category', () => {
        const result = narrowNav(
            [category({id: 'top', name: 'Handbook'}), category({id: 'sub', name: 'Ops', parentCategoryId: 'top'})],
            [page({id: 'a', title: 'Deploying', categoryId: 'sub'})],
            'deploy',
        );
        expect([...result!.categoryIds].sort()).toEqual(['sub', 'top']);
    });

    // Typing a section name means "show me that section", not "show me the rows inside it that
    // happen to repeat the name" - which would usually be none of them.
    it('keeps every page under a category whose own name matches', () => {
        const result = narrowNav(
            [category({id: 'c1', name: 'Operations'})],
            [page({id: 'a', title: 'Nothing alike', categoryId: 'c1'})],
            'operations',
        );
        expect(result!.pageIds.has('a')).toBe(true);
    });

    it('keeps pages of a subcategory of a matching category', () => {
        const result = narrowNav(
            [category({id: 'top', name: 'Operations'}), category({id: 'sub', name: 'Runbooks', parentCategoryId: 'top'})],
            [page({id: 'a', title: 'Nothing alike', categoryId: 'sub'})],
            'operations',
        );
        expect(result!.pageIds.has('a')).toBe(true);
        expect(result!.categoryIds.has('sub')).toBe(true);
    });

    it('drops everything when nothing matches', () => {
        const result = narrowNav(
            [category({id: 'c1', name: 'Operations'})],
            [page({id: 'a', title: 'Deploying', categoryId: 'c1'})],
            'zzzz',
        );
        expect(result!.pageIds.size).toBe(0);
        expect(result!.categoryIds.size).toBe(0);
    });

    // The DTOs allow a page to be its own ancestor; the nav's own tree builder defends against
    // the same shape, and a filter that hung on it would take the whole panel with it.
    it('terminates on a parent cycle', () => {
        const result = narrowNav([], [
            page({id: 'a', title: 'Deploying', parentPageId: 'b'}),
            page({id: 'b', title: 'Other', parentPageId: 'a'}),
        ], 'deploy');
        expect(result!.pageIds.has('a')).toBe(true);
    });

    it('terminates on a category cycle', () => {
        const result = narrowNav(
            [
                category({id: 'x', name: 'X', parentCategoryId: 'y'}),
                category({id: 'y', name: 'Y', parentCategoryId: 'x'}),
            ],
            [page({id: 'a', title: 'Deploying', categoryId: 'x'})],
            'deploy',
        );
        expect(result!.categoryIds.has('x')).toBe(true);
    });
});
