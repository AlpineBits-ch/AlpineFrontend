import {describe, expect, it} from 'vitest';
import {dayKey, dayRelationOf, UNKNOWN_DAY_KEY} from './day.helper';

describe('dayKey', () => {
    it('formats the local calendar day, zero padded', () => {
        expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    });

    it('does not shift the day across the UTC boundary', () => {
        // 23:00 local on the 14th is the 15th in UTC east of Greenwich, and the 14th is the answer.
        expect(dayKey(new Date(2026, 2, 14, 23, 0))).toBe('2026-03-14');
        expect(dayKey(new Date(2026, 2, 14, 0, 30))).toBe('2026-03-14');
    });

    it('returns the unknown key for an unparseable date', () => {
        expect(dayKey(new Date('nonsense'))).toBe(UNKNOWN_DAY_KEY);
    });
});

describe('dayRelationOf', () => {
    const now = new Date(2026, 2, 14, 10, 0, 0);

    it('names today and yesterday and leaves older days null', () => {
        expect(dayRelationOf('2026-03-14', now)).toBe('today');
        expect(dayRelationOf('2026-03-13', now)).toBe('yesterday');
        expect(dayRelationOf('2026-03-01', now)).toBe(null);
    });

    it('handles yesterday falling in the previous month', () => {
        expect(dayRelationOf('2026-02-28', new Date(2026, 2, 1, 10, 0))).toBe('yesterday');
    });

    it('handles yesterday falling in the previous year', () => {
        expect(dayRelationOf('2025-12-31', new Date(2026, 0, 1, 10, 0))).toBe('yesterday');
    });

    it('leaves a future day null', () => {
        expect(dayRelationOf('2026-03-15', now)).toBe(null);
    });

    it('leaves the unknown key null', () => {
        expect(dayRelationOf(UNKNOWN_DAY_KEY, now)).toBe(null);
    });
});
