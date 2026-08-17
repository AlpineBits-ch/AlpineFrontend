/** A grant whose `expiresAt` is in the past is not a grant: permission resolution stops honouring it at that instant, but listing rows are only cleaned up about a week later. */

/** The server's cap. Anything further out is rejected. */
export const GUEST_GRANT_MAX_MS = 365 * 24 * 60 * 60 * 1000;

export type GrantState = 'permanent' | 'live' | 'lapsed';

/** What `expiresAt` means right now; `null` is an ordinary permanent membership (every pre-guest-access membership has one). */
export function grantState(expiresAt: string | null | undefined, now: number = Date.now()): GrantState {
    if (expiresAt == null) return 'permanent';
    const at = Date.parse(expiresAt);
    // An unparseable expiry is treated as lapsed, not live: fail closed rather than draw access that may not exist.
    if (Number.isNaN(at)) return 'lapsed';
    return at > now ? 'live' : 'lapsed';
}

/** Whether this membership is actually granting anything at the moment. */
export function isGrantActive(expiresAt: string | null | undefined, now: number = Date.now()): boolean {
    return grantState(expiresAt, now) !== 'lapsed';
}

/** Whether the row is a *temporary* grant that is still running. */
export function isTemporaryAndLive(expiresAt: string | null | undefined, now: number = Date.now()): boolean {
    return grantState(expiresAt, now) === 'live';
}

/** `null` when the requested end is in the past or beyond the one-year cap. */
export function guestExpiryFromNow(durationMs: number, now: number = Date.now()): string | null {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
    if (durationMs > GUEST_GRANT_MAX_MS) return null;
    return new Date(now + durationMs).toISOString();
}

/** Durations the grant dialog offers, in milliseconds. All inside the one-year cap. */
export const GUEST_DURATIONS: readonly { labelKey: string; ms: number }[] = [
    {labelKey: 'GUEST_ACCESS.DURATION.HOURS_6', ms: 6 * 60 * 60 * 1000},
    {labelKey: 'GUEST_ACCESS.DURATION.DAY_1', ms: 24 * 60 * 60 * 1000},
    {labelKey: 'GUEST_ACCESS.DURATION.DAYS_3', ms: 3 * 24 * 60 * 60 * 1000},
    {labelKey: 'GUEST_ACCESS.DURATION.WEEK_1', ms: 7 * 24 * 60 * 60 * 1000},
    {labelKey: 'GUEST_ACCESS.DURATION.WEEKS_2', ms: 14 * 24 * 60 * 60 * 1000},
    {labelKey: 'GUEST_ACCESS.DURATION.MONTH_1', ms: 30 * 24 * 60 * 60 * 1000},
];
