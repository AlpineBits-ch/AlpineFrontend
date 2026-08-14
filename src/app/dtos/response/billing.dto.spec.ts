import {describe, expect, it} from 'vitest';
import {sameSubjectKind, subscriptionStanding} from './billing.dto';

/**
 * The one piece of logic in the billing DTOs, and the reason it exists.
 *
 * <p>`status` is Stripe's vocabulary passed through unchanged, and Stripe adds to it. The property
 * that matters is not which bucket `past_due` lands in but that <b>every</b> string lands in one,
 * and that the one an unknown value lands in is never `live`.</p>
 */
describe('subscriptionStanding', () => {
    it('treats the two paid-up statuses as live', () => {
        expect(subscriptionStanding('active')).toBe('live');
        expect(subscriptionStanding('trialing')).toBe('live');
    });

    it('treats an unconfirmed first payment as pending, which is the poll-and-wait state', () => {
        expect(subscriptionStanding('incomplete')).toBe('pending');
    });

    it('treats the money-owed statuses as needing attention', () => {
        expect(subscriptionStanding('past_due')).toBe('attention');
        expect(subscriptionStanding('unpaid')).toBe('attention');
        expect(subscriptionStanding('paused')).toBe('attention');
    });

    it('treats the terminal statuses as ended', () => {
        expect(subscriptionStanding('canceled')).toBe('ended');
        expect(subscriptionStanding('incomplete_expired')).toBe('ended');
    });

    it('sends a status Stripe added after this build was made to attention, never to live', () => {
        // The negative case, and the whole point: a tier is never granted on the strength of a
        // string nobody here has seen.
        expect(subscriptionStanding('some_future_status')).toBe('attention');
        expect(subscriptionStanding('')).toBe('attention');
    });
});

/**
 * One screen renders both the catalogue and the entitlement snapshot, and the contract settled on
 * lowercase for exactly that reason. This is the tolerance around it: the type is open, this client
 * is pointed at instances running older builds, and a payload that arrives as `"Guild"` should land
 * on the guild screen rather than nowhere.
 */
describe('sameSubjectKind', () => {
    it('matches the casing the contract specifies', () => {
        expect(sameSubjectKind('guild', 'guild')).toBe(true);
        expect(sameSubjectKind('user', 'user')).toBe(true);
    });

    it('matches across the casing a staff endpoint or an older build would send', () => {
        expect(sameSubjectKind('Guild', 'guild')).toBe(true);
        expect(sameSubjectKind('user', ' USER ')).toBe(true);
    });

    it('does not match two different sides of the product', () => {
        expect(sameSubjectKind('guild', 'user')).toBe(false);
    });

    /** Absent is not evidence of anything, and treating it as one puts guild plans on an account. */
    it('never matches an absent or blank kind, not even against another one', () => {
        expect(sameSubjectKind(undefined, undefined)).toBe(false);
        expect(sameSubjectKind(null, 'guild')).toBe(false);
        expect(sameSubjectKind('', '')).toBe(false);
    });
});
