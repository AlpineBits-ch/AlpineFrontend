import {describe, expect, it} from 'vitest';
import {Absence, ABSENCE_LIMITS, absenceDraftError, absenceState} from './absence.dto';

const NOW = Date.parse('2026-08-15T12:00:00Z');

function absence(startAt: string, endAt: string): Absence {
    return {
        id: 'a1',
        guildId: 'g1',
        userId: 'u1',
        startAt,
        endAt,
        createdByUserId: 'u1',
        createdAt: '2026-08-01T00:00:00Z',
    };
}

describe('absenceState', () => {
    it('reads a window around now as current', () => {
        expect(absenceState(absence('2026-08-10T00:00:00Z', '2026-08-20T00:00:00Z'), NOW)).toBe('current');
    });

    it('reads a future window as upcoming', () => {
        expect(absenceState(absence('2026-09-01T00:00:00Z', '2026-09-08T00:00:00Z'), NOW)).toBe('upcoming');
    });

    it('reads a finished window as past', () => {
        expect(absenceState(absence('2026-07-01T00:00:00Z', '2026-07-08T00:00:00Z'), NOW)).toBe('past');
    });

    /**
     * `endAt` is exclusive - an absence ending at 12:00 does not cover a chore due at 12:00 - so
     * one ending at this exact instant is already over rather than still running.
     */
    it('treats an end exactly at now as past, because the boundary is exclusive', () => {
        expect(absenceState(absence('2026-08-10T00:00:00Z', '2026-08-15T12:00:00Z'), NOW)).toBe('past');
    });

    it('treats a start exactly at now as current', () => {
        expect(absenceState(absence('2026-08-15T12:00:00Z', '2026-08-20T00:00:00Z'), NOW)).toBe('current');
    });
});

describe('absenceDraftError', () => {
    const start = new Date('2026-08-10T00:00:00Z');

    it('accepts an ordinary window', () => {
        expect(absenceDraftError(start, new Date('2026-08-20T00:00:00Z'))).toBeNull();
    });

    it('refuses a missing date', () => {
        expect(absenceDraftError(null, new Date())).toBe('missing');
        expect(absenceDraftError(start, null)).toBe('missing');
    });

    it('refuses an end before the start, and a zero-length window', () => {
        expect(absenceDraftError(start, new Date('2026-08-01T00:00:00Z'))).toBe('inverted');
        expect(absenceDraftError(start, start)).toBe('inverted');
    });

    it('refuses a window past the server cap', () => {
        const tooLong = new Date(start.getTime() + (ABSENCE_LIMITS.maxDays + 1) * 86_400_000);
        expect(absenceDraftError(start, tooLong)).toBe('too-long');
    });

    it('accepts a window at exactly the cap', () => {
        const atCap = new Date(start.getTime() + ABSENCE_LIMITS.maxDays * 86_400_000);
        expect(absenceDraftError(start, atCap)).toBeNull();
    });
});
