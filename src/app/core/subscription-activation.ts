import {InjectionToken} from '@angular/core';
import {SubscriptionDto, subscriptionStanding} from '../dtos/response/billing.dto';

/**
 * Waiting for the webhook, which is the only thing that can make a subscription live.
 *
 * <p><b>The client is never the source of truth for activation.</b> A successful `confirmPayment`
 * means the card worked; the subscription becomes live when Stripe's webhook reaches our Billing
 * service and it writes the assignment. So the screen that took the payment polls, and the code
 * that polls lives here rather than inside a component: it has one interesting property - what it
 * does when it runs out of patience - and that property is untestable from a component that also
 * wants Stripe.js, a dialog and an HTTP client.</p>
 */

/**
 * How the wait ended.
 *
 * <ul>
 *   <li>`live` - the webhook landed and the subject has what they paid for.</li>
 *   <li>`ended` - the subscription reached a terminal status instead. The payment did not stand up,
 *       and this is the only outcome that may say so.</li>
 *   <li>`slow` - the budget ran out with nothing decided. <b>Not a failure.</b> The subscription is
 *       most likely being activated right now, and telling somebody their payment failed when it
 *       did not is the worst outcome available on this screen.</li>
 * </ul>
 */
export type ActivationOutcome = 'live' | 'ended' | 'slow';

export interface ActivationResult {
    outcome: ActivationOutcome;
    /** The last subscription read, or null when every read failed. */
    subscription: SubscriptionDto | null;
}

/**
 * The backoff, and the whole budget it adds up to.
 *
 * <p>Roughly thirty seconds across nine reads, front-loaded because the webhook usually arrives in
 * the first second or two and a customer staring at a spinner notices the first gap most. Bounded
 * because an unbounded poll against a webhook that is never coming is a request every few seconds
 * for as long as the dialog is open.</p>
 */
export const ACTIVATION_BACKOFF_MS: readonly number[] =
    [400, 800, 1200, 2000, 3000, 4000, 5000, 6000, 8000];

/**
 * The backoff a screen polls with, as a seam.
 *
 * <p>Overridden by tests and by nothing else - the same arrangement `STRIPE_JS_LOADER` uses, and
 * for the same reason: the interesting property of this wait is what it does when it runs out, and
 * proving that against thirty seconds of real time is a test nobody runs.</p>
 */
export const ACTIVATION_POLL_BACKOFF = new InjectionToken<readonly number[]>(
    'ACTIVATION_POLL_BACKOFF',
    {providedIn: 'root', factory: () => ACTIVATION_BACKOFF_MS},
);

export interface ActivationPollOptions {
    /** Overridden in tests, and by nothing else. */
    backoffMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Polls one subscription until it is live, terminal, or the budget is spent.
 *
 * <p>A read that throws does not end the wait and never produces `ended`. The failure modes of a
 * single GET here - a dropped connection, a 502 from the gateway, a token refresh in flight - say
 * nothing whatsoever about whether the money moved, and the one thing this function must not do is
 * turn a network blip into "your payment failed". A wait where every read failed is `slow` with a
 * null subscription, which is the same sentence to the customer and a distinguishable state to the
 * caller.</p>
 *
 * <p>The first read happens before the first sleep: a subscription that was already active when
 * `create` returned - which is what a `null` clientSecret means - is answered immediately rather
 * than after a wait for nothing.</p>
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
            // Deliberately swallowed. See the note above: a failed read is not a failed payment,
            // and the retry is the whole point of the budget.
        }

        if (attempt >= backoff.length) return {outcome: 'slow', subscription: last};
        await sleep(backoff[attempt]);
    }
}
