import {groupRevisionsByDay, toSideBySide} from './wiki-history-view';
import {diffLines} from '../wiki-diff';
import {WikiRevisionDto} from '../../../../../dtos/response/wiki.dto';

function revision(id: string, createdAt: Date, revisionNumber = 1): WikiRevisionDto {
    return {id, pageId: 'p', content: '', editorId: 'e', createdAt, revisionNumber};
}

describe('toSideBySide', () => {
    it('puts context on both sides', () => {
        expect(toSideBySide(diffLines('a', 'a'))).toEqual([{kind: 'ctx', left: 'a', right: 'a'}]);
    });

    // The whole point of the two-column view: "was X" has to sit opposite "now Y".
    it('pairs a replaced line across the gutter', () => {
        expect(toSideBySide(diffLines('one', 'two'))).toEqual([{kind: 'mod', left: 'one', right: 'two'}]);
    });

    it('leaves the opposite side empty for a pure insertion', () => {
        expect(toSideBySide(diffLines('a', 'a\nb'))).toEqual([
            {kind: 'ctx', left: 'a', right: 'a'},
            {kind: 'add', left: null, right: 'b'},
        ]);
    });

    it('leaves the opposite side empty for a pure deletion', () => {
        expect(toSideBySide(diffLines('a\nb', 'a'))).toEqual([
            {kind: 'ctx', left: 'a', right: 'a'},
            {kind: 'del', left: 'b', right: null},
        ]);
    });

    it('zips uneven runs, pairing what it can and stacking the remainder', () => {
        const rows = toSideBySide([
            {type: 'del', text: 'x'},
            {type: 'del', text: 'y'},
            {type: 'add', text: 'z'},
        ]);
        expect(rows).toEqual([
            {kind: 'mod', left: 'x', right: 'z'},
            {kind: 'del', left: 'y', right: null},
        ]);
    });

    it('flushes a trailing run at the end of the diff', () => {
        expect(toSideBySide([{type: 'add', text: 'tail'}])).toEqual([
            {kind: 'add', left: null, right: 'tail'},
        ]);
    });

    it('returns nothing for an empty diff', () => {
        expect(toSideBySide([])).toEqual([]);
    });
});

describe('groupRevisionsByDay', () => {
    const now = new Date(2026, 2, 14, 10, 0, 0);

    it('buckets revisions from the same local day together', () => {
        const groups = groupRevisionsByDay(
            [revision('a', new Date(2026, 2, 14, 9, 0)), revision('b', new Date(2026, 2, 14, 1, 0))],
            now,
        );
        expect(groups.length).toBe(1);
        expect(groups[0].revisions.map(r => r.id)).toEqual(['a', 'b']);
    });

    it('labels today and yesterday, and leaves older days to the formatter', () => {
        const groups = groupRevisionsByDay(
            [
                revision('a', new Date(2026, 2, 14, 9, 0)),
                revision('b', new Date(2026, 2, 13, 9, 0)),
                revision('c', new Date(2026, 2, 1, 9, 0)),
            ],
            now,
        );
        expect(groups.map(g => g.relation)).toEqual(['today', 'yesterday', null]);
    });

    // Crossing a month boundary backwards is where a naive `date - 1` breaks.
    it('handles yesterday falling in the previous month', () => {
        const groups = groupRevisionsByDay(
            [revision('a', new Date(2026, 2, 0, 23, 0))],
            new Date(2026, 2, 1, 10, 0),
        );
        expect(groups[0].relation).toBe('yesterday');
    });

    it('keeps the order the server sent rather than re-sorting', () => {
        const groups = groupRevisionsByDay(
            [revision('new', new Date(2026, 2, 14, 9, 0)), revision('old', new Date(2026, 1, 2, 9, 0))],
            now,
        );
        expect(groups.map(g => g.revisions[0].id)).toEqual(['new', 'old']);
    });

    it('gives an unparseable date its own bucket instead of poisoning a real one', () => {
        const groups = groupRevisionsByDay([revision('bad', 'nonsense' as unknown as Date)], now);
        expect(groups.length).toBe(1);
        expect(groups[0].key).toBe('unknown');
    });
});
