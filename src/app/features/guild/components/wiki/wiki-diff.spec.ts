import {diffLines, diffStat} from './wiki-diff';

describe('diffLines', () => {
    it('reports every line as context when both sides are identical', () => {
        expect(diffLines('a\nb', 'a\nb')).toEqual([
            {type: 'ctx', text: 'a'},
            {type: 'ctx', text: 'b'},
        ]);
    });

    // '' must not become [''] via split, or an empty document reports one phantom line.
    it('treats an empty before side as pure addition', () => {
        expect(diffLines('', 'a')).toEqual([{type: 'add', text: 'a'}]);
    });

    it('treats an empty after side as pure deletion', () => {
        expect(diffLines('a', '')).toEqual([{type: 'del', text: 'a'}]);
    });

    it('reports nothing for two empty sides', () => {
        expect(diffLines('', '')).toEqual([]);
    });

    it('finds a line inserted in the middle', () => {
        expect(diffLines('a\nc', 'a\nb\nc')).toEqual([
            {type: 'ctx', text: 'a'},
            {type: 'add', text: 'b'},
            {type: 'ctx', text: 'c'},
        ]);
    });

    it('finds a line removed from the middle', () => {
        expect(diffLines('a\nb\nc', 'a\nc')).toEqual([
            {type: 'ctx', text: 'a'},
            {type: 'del', text: 'b'},
            {type: 'ctx', text: 'c'},
        ]);
    });

    it('reports a replaced line as a deletion followed by an addition', () => {
        expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
            {type: 'ctx', text: 'a'},
            {type: 'del', text: 'b'},
            {type: 'add', text: 'x'},
            {type: 'ctx', text: 'c'},
        ]);
    });

    it('keeps the common subsequence when a block moves', () => {
        const result = diffLines('a\nb\nc', 'c\na\nb');
        expect(result.filter(l => l.type === 'ctx').map(l => l.text)).toEqual(['a', 'b']);
        expect(result.filter(l => l.type === 'add').map(l => l.text)).toEqual(['c']);
        expect(result.filter(l => l.type === 'del').map(l => l.text)).toEqual(['c']);
    });

    it('preserves blank lines inside content rather than collapsing them', () => {
        expect(diffLines('a\n\nb', 'a\n\nb')).toHaveLength(3);
    });
});

describe('diffStat', () => {
    it('counts additions and removals and ignores context', () => {
        expect(diffStat(diffLines('a\nb\nc', 'a\nx\nc'))).toEqual({added: 1, removed: 1});
    });

    it('reports zeroes for an unchanged document', () => {
        expect(diffStat(diffLines('a', 'a'))).toEqual({added: 0, removed: 0});
    });
});
