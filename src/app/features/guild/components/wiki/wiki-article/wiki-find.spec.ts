import {findMatchesInBlocks, findMatchesInText, matchNearest} from './wiki-find';

describe('findMatchesInText', () => {
    it('is case-insensitive by default', () => {
        expect(findMatchesInText('Deploy the deployment', 'deploy')).toEqual([
            {from: 0, to: 6},
            {from: 11, to: 17},
        ]);
    });

    it('honours case sensitivity', () => {
        expect(findMatchesInText('Deploy the deployment', 'deploy', {caseSensitive: true})).toEqual([
            {from: 11, to: 17},
        ]);
    });

    it('matches whole words only when asked', () => {
        const text = 'deploy the deployment';

        expect(findMatchesInText(text, 'deploy', {wholeWord: true})).toEqual([{from: 0, to: 6}]);
        expect(findMatchesInText(text, 'deploy')).toHaveLength(2);
    });

    it('treats punctuation as a word boundary', () => {
        expect(findMatchesInText('run (deploy) now', 'deploy', {wholeWord: true})).toEqual([
            {from: 5, to: 11},
        ]);
    });

    it('counts repeated runs without overlapping them', () => {
        expect(findMatchesInText('aaaa', 'aa')).toEqual([
            {from: 0, to: 2},
            {from: 2, to: 4},
        ]);
    });

    it('answers nothing for a query that matches nothing, and for an empty query', () => {
        expect(findMatchesInText('nothing here', 'zzz')).toEqual([]);
        expect(findMatchesInText('nothing here', '')).toEqual([]);
    });
});

describe('findMatchesInBlocks', () => {
    it('offsets every match by its block base', () => {
        const blocks = [
            {text: 'first paragraph', base: 1},
            {text: 'second paragraph', base: 20},
        ];

        expect(findMatchesInBlocks(blocks, 'paragraph')).toEqual([
            {from: 7, to: 16},
            {from: 27, to: 36},
        ]);
    });

    /** Bold, a link and plain text in one paragraph flatten to one string before this runs. */
    it('matches across what were separate inline marks', () => {
        const blocks = [{text: 'the deploy button', base: 1}];

        expect(findMatchesInBlocks(blocks, 'deploy but')).toEqual([{from: 5, to: 15}]);
    });

    it('never matches across a block boundary', () => {
        const blocks = [
            {text: 'ends with de', base: 1},
            {text: 'ploy starts', base: 20},
        ];

        expect(findMatchesInBlocks(blocks, 'deploy')).toEqual([]);
    });
});

describe('matchNearest', () => {
    const matches = [
        {from: 5, to: 9},
        {from: 30, to: 34},
    ];

    it('picks the first match at or after the caret', () => {
        expect(matchNearest(matches, 0)).toBe(0);
        expect(matchNearest(matches, 10)).toBe(1);
    });

    it('falls back to the last match when the caret is past all of them', () => {
        expect(matchNearest(matches, 99)).toBe(1);
    });

    it('reports -1 with nothing to pick', () => {
        expect(matchNearest([], 0)).toBe(-1);
    });
});
