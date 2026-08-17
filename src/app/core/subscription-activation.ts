import {InjectionToken} from '@angular/core';
import {SubscriptionDto, subscriptionStanding} from '../dtos/response/billing.dto';

/** Waiting for the webhook. The client is never the source of truth for activation. */

/** How the wait ended. `slow` means undecided, never failed; only `ended` may say a payment failed. */
export type ActivationOutcome = 'live' | 'ended' | 'slow';

export interface ActivationResult {
    outcome: ActivationOutcome;
    /** The last subscription read, or null when every read failed. */
    subscription: SubscriptionDto | null;
}

/** The backoff: roughly thirty seconds across nine reads, front-loaded. */
export const ACTIVATION_BACKOFF_MS: readonly number[] = [400, 800, 1200, 2000, 3000, 4000, 5000, 6000, 8000];

/** The backoff a screen polls with, as a seam. Overridden by tests and by nothing else. */
export const ACTIVATION_POLL_BACKOFF = new InjectionToken<readonly number[]>('ACTIVATION_POLL_BACKOFF', {
    providedIn: 'root',
    factory: () => ACTIVATION_BACKOFF_MS,
});

export interface ActivationPollOptions {
    /** Overridden in tests, and by nothing else. */
    backoffMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Polls one subscription until it is live, terminal, or the budget is spent. A read that throws
 * never produces `ended`. The first read happens before the first sleep.
 */
export async function awaitActivation(
    read: () => Promise<SubscriptionDto>,
    options: ActivationPollOptions = {},
): Promise<ActivationResult> {
    const backoff = options.backoffMs ?? ACTIVATION_BACKOFF_MS;
    const sleep = options.sleep ?? realSleep;

    let last: SubscriptionDto | null = null;

    for (let attempt = 0; ; attempt++) {
        try {
            last = await read();
            const standing = subscriptionStanding(last.status);
            if (standing === 'live') return {outcome: 'live', subscription: last};
            if (standing === 'ended') return {outcome: 'ended', subscription: last};
        } catch {
            // Swallowed: a failed read is not a failed payment.
        }

        if (attempt >= backoff.length) return {outcome: 'slow', subscription: last};
        await sleep(backoff[attempt]);
    }
}
