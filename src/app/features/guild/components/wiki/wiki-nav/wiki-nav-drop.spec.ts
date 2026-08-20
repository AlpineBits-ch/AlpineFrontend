import {describe, expect, it} from 'vitest';

import {DropModel, dropIntent, wouldCreateCategoryCycle, wouldCreatePageCycle} from './wiki-nav-drop';

/**
 * Guides(c1) > Deploy(c1a), Api(c2).
 * Alpha(p1) > Beta(p2) > Gamma(p3) in c1, Delta(p4) in c2, Loose(p5) nowhere.
 */
const WIKI: DropModel = {
    categories: [{id: 'c1'}, {id: 'c2'}, {id: 'c1a', parentCategoryId: 'c1'}],
    pages: [
        {id: 'p1', categoryId: 'c1'},
        {id: 'p2', categoryId: 'c1', parentPageId: 'p1'},
        {id: 'p3', categoryId: 'c1', parentPageId: 'p2'},
        {id: 'p4', categoryId: 'c2'},
        {id: 'p5'},
    ],
};

const category = (id: string) => ({type: 'category' as const, id});
const page = (id: string) => ({type: 'page' as const, id});

describe('dropIntent', () => {
    it('reorders a category among its own siblings', () => {
        expect(dropIntent(category('c1'), category('c2'), 0.2, WIKI)).toEqual({
            kind: 'reorder',
            position: 'before',
        });
        expect(dropIntent(category('c1'), category('c2'), 0.8, WIKI)).toEqual({
            kind: 'reorder',
            position: 'after',
        });
    });

    it('refuses a category dropped on one with a different parent', () => {
        expect(dropIntent(category('c2'), category('c1a'), 0.5, WIKI)).toEqual({
            kind: 'none',
            reason: 'different-parent',
        });
    });

    it('refuses a category dropped on its own descendant', () => {
        expect(dropIntent(category('c1'), category('c1a'), 0.5, WIKI)).toEqual({
            kind: 'none',
            reason: 'cycle',
        });
    });

    it('refuses a category dropped on a page', () => {
        expect(dropIntent(category('c1'), page('p1'), 0.5, WIKI)).toEqual({
            kind: 'none',
            reason: 'not-a-target',
        });
    });

    it('files a page into a category wherever on the header it lands', () => {
        for (const offset of [0, 0.1, 0.5, 0.9, 1]) {
            expect(dropIntent(page('p4'), category('c1'), offset, WIKI)).toEqual({kind: 'into'});
        }
    });

    // The top half used to mean "uncategorise", on a row that drew the same line either way.
    it('never uncategorises a page from a category header', () => {
        expect(dropIntent(page('p4'), category('c1'), 0, WIKI).kind).not.toBe('none');
        expect(dropIntent(page('p4'), category('c1'), 0, WIKI)).toEqual({kind: 'into'});
    });

    it('files a nested page into a category it already sits in, which un-nests it', () => {
        expect(dropIntent(page('p2'), category('c1'), 0.5, WIKI)).toEqual({kind: 'into'});
    });

    it('refuses a page dropped on the category it already sits loose in', () => {
        expect(dropIntent(page('p1'), category('c1'), 0.5, WIKI)).toEqual({
            kind: 'none',
            reason: 'no-op',
        });
    });

    it('nests a page under another page, at any point of the row', () => {
        for (const offset of [0, 0.5, 1]) {
            expect(dropIntent(page('p4'), page('p1'), offset, WIKI)).toEqual({kind: 'nest'});
        }
    });

    it('refuses a page dropped on its own descendant', () => {
        expect(dropIntent(page('p1'), page('p3'), 0.5, WIKI)).toEqual({kind: 'none', reason: 'cycle'});
    });

    it('refuses a page dropped on itself', () => {
        expect(dropIntent(page('p1'), page('p1'), 0.5, WIKI)).toEqual({kind: 'none', reason: 'self'});
    });

    it('refuses a page dropped on the parent it already has', () => {
        expect(dropIntent(page('p2'), page('p1'), 0.5, WIKI)).toEqual({kind: 'none', reason: 'no-op'});
    });

    it('nests a loose page under a categorized one', () => {
        expect(dropIntent(page('p5'), page('p4'), 0.5, WIKI)).toEqual({kind: 'nest'});
    });

    it('answers none when there is nothing being dragged', () => {
        expect(dropIntent(null, page('p1'), 0.5, WIKI)).toEqual({kind: 'none', reason: 'missing'});
        expect(dropIntent(page('p1'), null, 0.5, WIKI)).toEqual({kind: 'none', reason: 'missing'});
    });

    it('answers none for a row that is no longer in the wiki', () => {
        expect(dropIntent(page('gone'), page('p1'), 0.5, WIKI)).toEqual({
            kind: 'none',
            reason: 'missing',
        });
    });
});

describe('cycle guards', () => {
    it('spots a page made its own ancestor', () => {
        expect(wouldCreatePageCycle('p1', 'p3', WIKI.pages)).toBe(true);
        expect(wouldCreatePageCycle('p1', 'p1', WIKI.pages)).toBe(true);
        expect(wouldCreatePageCycle('p4', 'p3', WIKI.pages)).toBe(false);
    });

    // Data already holding a loop must not hang the walk.
    it('terminates on data that already loops', () => {
        const looped = [{id: 'a', parentPageId: 'b'}, {id: 'b', parentPageId: 'a'}, {id: 'c'}];
        expect(wouldCreatePageCycle('c', 'a', looped)).toBe(false);
    });

    it('spots a category made its own ancestor', () => {
        expect(wouldCreateCategoryCycle('c1', 'c1a', WIKI.categories)).toBe(true);
        expect(wouldCreateCategoryCycle('c2', 'c1a', WIKI.categories)).toBe(false);
    });
});
