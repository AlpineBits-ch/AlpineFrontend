import {describe, expect, it} from 'vitest';
import {
    GUEST_GRANT_MAX_MS,
    grantState,
    guestExpiryFromNow,
    isGrantActive,
    isTemporaryAndLive,
} from './guest-access';

const NOW = Date.parse('2026-08-03T12:00:00Z');

describe('grantState', () => {
    it('reports a null expiry as permanent - every membership predating guest access has one', () => {
        expect(grantState(null, NOW)).toBe('permanent');
        expect(grantState(undefined, NOW)).toBe('permanent');
    });

    it('reports a future expiry as live', () => {
        expect(grantState('2026-08-08T12:00:00Z', NOW)).toBe('live');
    });

    /**
     * The whole point of the rule: role listings keep returning lapsed rows for about a week
     * after they stop granting anything, so "it came back from the API" is not "it is granted".
     */
    it('reports a past expiry as lapsed even though the row is still in the listing', () => {
        expect(grantState('2026-08-02T12:00:00Z', NOW)).toBe('lapsed');
    });

    it('lapses at the exact instant of expiry, not a moment later', () => {
        expect(grantState(new Date(NOW).toISOString(), NOW)).toBe('lapsed');
        expect(grantState(new Date(NOW + 1).toISOString(), NOW)).toBe('live');
    });

    it('treats an unparseable expiry as lapsed rather than as access', () => {
        expect(grantState('not-a-date', NOW)).toBe('lapsed');
    });
});

describe('isGrantActive', () => {
    it('is true for permanent and live memberships and false for lapsed ones', () => {
        expect(isGrantActive(null, NOW)).toBe(true);
        expect(isGrantActive('2026-08-08T12:00:00Z', NOW)).toBe(true);
        expect(isGrantActive('2026-07-30T12:00:00Z', NOW)).toBe(false);
    });
});

describe('isTemporaryAndLive', () => {
    it('excludes permanent memberships - they are not guest grants', () => {
        expect(isTemporaryAndLive(null, NOW)).toBe(false);
        expect(isTemporaryAndLive('2026-08-08T12:00:00Z', NOW)).toBe(true);
        expect(isTemporaryAndLive('2026-07-30T12:00:00Z', NOW)).toBe(false);
    });
});

describe('guestExpiryFromNow', () => {
    it('produces an ISO instant the requested distance out', () => {
        const day = 24 * 60 * 60 * 1000;
        expect(guestExpiryFromNow(5 * day, NOW)).toBe(new Date(NOW + 5 * day).toISOString());
    });

    it('refuses anything past the one-year cap', () => {
        expect(guestExpiryFromNow(GUEST_GRANT_MAX_MS, NOW)).not.toBeNull();
        expect(guestExpiryFromNow(GUEST_GRANT_MAX_MS + 1, NOW)).toBeNull();
    });

    it('refuses a zero or negative duration', () => {
        expect(guestExpiryFromNow(0, NOW)).toBeNull();
        expect(guestExpiryFromNow(-1000, NOW)).toBeNull();
    });
});
