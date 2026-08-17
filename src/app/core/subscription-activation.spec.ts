import {describe, expect, it, vi} from 'vitest';
import {SubscriptionDto} from '../dtos/response/billing.dto';
import {awaitActivation} from './subscription-activation';

function subscription(status: string): SubscriptionDto {
    return {
        id: 'sub_1',
        subjectKind: 'guild',
        subjectId: 'gld_1',
        planName: 'pro',
        planDisplayName: 'Pro',
        versionNumber: 3,
        status,
        currentPeriodEnd: '2026-09-14T10:12:00Z',
        cancelAtPeriodEnd: false,
        gracePeriodEndsAt: null,
        priceMinorUnits: 2900,
        currency: 'usd',
        isPayer: true,
    };
}

/** No real time passes in this file; the backoff is a seam precisely so it does not have to. */
function options(steps = 3) {
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    return {sleep, backoffMs: new Array(steps).fill(10) as number[]};
}

describe('awaitActivation - the webhook lands', () => {
    it('stops on the first read when the subscription is already active', async () => {
        const read = vi.fn().mockResolvedValue(subscription('active'));
        const opts = options();

        const result = await awaitActivation(read, opts);

        expect(result.outcome).toBe('live');
        expect(read).toHaveBeenCalledTimes(1);
        // Nothing slept: a `null` clientSecret means Stripe had nothing to confirm, and waiting
        // half a second to discover that is half a second of a spinner for nothing.
        expect(opts.sleep).not.toHaveBeenCalled();
    });

    it('keeps polling through the pending state until the webhook arrives', async () => {
        const read = vi
            .fn()
            .mockResolvedValueOnce(subscription('incomplete'))
            .mockResolvedValueOnce(subscription('incomplete'))
            .mockResolvedValue(subscription('trialing'));

        const result = await awaitActivation(read, options());

        expect(result.outcome).toBe('live');
        expect(result.subscription?.status).toBe('trialing');
        expect(read).toHaveBeenCalledTimes(3);
    });
});

describe('awaitActivation - the payment did not stand up', () => {
    it('stops on a terminal status, which is the only outcome allowed to say it failed', async () => {
        const read = vi.fn().mockResolvedValue(subscription('incomplete_expired'));

        const result = await awaitActivation(read, options());

        expect(result.outcome).toBe('ended');
        expect(read).toHaveBeenCalledTimes(1);
    });
});

describe('awaitActivation - running out of patience', () => {
    /**
     * The load-bearing case. The subscription is most likely being activated at this very moment,
     * and the one thing this must not answer is "your payment failed".
     */
    it('answers slow, not failed, when the budget is spent with nothing decided', async () => {
        const read = vi.fn().mockResolvedValue(subscription('incomplete'));
        const opts = options(4);

        const result = await awaitActivation(read, opts);

        expect(result.outcome).toBe('slow');
        expect(result.subscription?.status).toBe('incomplete');
        // Bounded: four sleeps, five reads, and then it stops rather than polling forever.
        expect(opts.sleep).toHaveBeenCalledTimes(4);
        expect(read).toHaveBeenCalledTimes(5);
    });

    it('waits the backoff it was given, in order', async () => {
        const read = vi.fn().mockResolvedValue(subscription('incomplete'));
        const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

        await awaitActivation(read, {sleep, backoffMs: [5, 25, 125]});

        expect(sleep.mock.calls.map(call => call[0])).toEqual([5, 25, 125]);
    });

    /** A dropped connection says nothing about whether the money moved. It is not a failure. */
    it('retries a read that threw instead of calling the purchase off', async () => {
        const read = vi
            .fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValue(subscription('active'));

        const result = await awaitActivation(read, options());

        expect(result.outcome).toBe('live');
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('answers slow with no subscription when every single read failed', async () => {
        const read = vi.fn().mockRejectedValue(new Error('gateway'));

        const result = await awaitActivation(read, options(2));

        // Distinguishable to the caller, and the same sentence to the customer either way.
        expect(result.outcome).toBe('slow');
        expect(result.subscription).toBeNull();
    });
});
