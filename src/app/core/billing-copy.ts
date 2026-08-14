import {BILLING_ERROR_CODES, describeBillingError} from '../services/billing.service';

/**
 * What to tell a customer about a billing refusal.
 *
 * <p>The codes are a server vocabulary and the sentences are ours, so the mapping lives here as a
 * table of <b>literal</b> keys. `'BILLING.ERROR.' + code` is the obvious spelling and is exactly
 * what `i18n-keys.spec.ts` cannot see: it matches a literal key next to a `translate`, so a computed
 * one renders raw to the user with every test in this repo green.</p>
 *
 * <p>Two things are never rendered: the code itself and the HTTP status. "409" is not a sentence,
 * and a person who has just been refused a purchase needs to be told what to do instead.</p>
 */

const ERROR_KEYS: Record<string, string> = {
    [BILLING_ERROR_CODES.billingDisabled]: 'BILLING.ERROR.DISABLED',
    [BILLING_ERROR_CODES.notPurchasable]: 'BILLING.ERROR.NOT_PURCHASABLE',
    [BILLING_ERROR_CODES.alreadySubscribed]: 'BILLING.ERROR.ALREADY_SUBSCRIBED',
    [BILLING_ERROR_CODES.notPermitted]: 'BILLING.ERROR.NOT_PERMITTED',
    [BILLING_ERROR_CODES.notThePayer]: 'BILLING.ERROR.NOT_THE_PAYER',
    [BILLING_ERROR_CODES.subscriptionLapsed]: 'BILLING.ERROR.SUBSCRIPTION_LAPSED',
    [BILLING_ERROR_CODES.lastPaymentMethod]: 'BILLING.ERROR.LAST_PAYMENT_METHOD',
    /** Only reached when the 502 carried no detail; the detail is the better sentence. */
    [BILLING_ERROR_CODES.stripeError]: 'BILLING.ERROR.STRIPE',
};

/** A code this build has never heard of, and every failure that is not problem+json. */
export const BILLING_GENERIC_ERROR_KEY = 'BILLING.ERROR.GENERIC';

/** For the spec that proves every key this file can produce resolves in en.json. */
export const BILLING_ERROR_TRANSLATION_KEYS: readonly string[] = [
    ...Object.values(ERROR_KEYS),
    BILLING_GENERIC_ERROR_KEY,
];

/**
 * One refusal, as either a sentence of ours or a sentence of Stripe's.
 *
 * <p>Exactly one of the two is set. `text` wins where it is present, and it is present only for
 * `stripe_error`, whose `detail` the contract states is already customer-worded and safe to
 * display - "Your card was declined" reads better than anything we could write without knowing
 * which of the several dozen decline reasons it was.</p>
 */
export interface BillingErrorCopy {
    /** Null when {@link text} carries the sentence instead. */
    key: string | null;
    /** A server sentence to render verbatim, or null. Never a code and never a status. */
    text: string | null;
}

/**
 * The sentence for a billing failure.
 *
 * <p>An unrecognised code falls through to the generic sentence rather than crashing or rendering
 * the code, because this table will grow: the contract says so in the same paragraph that defines
 * it. Something that is not an HTTP error at all - a rejected promise from Stripe.js, a bug in this
 * client - lands there too, which is the honest answer for a failure nobody classified.</p>
 */
export function billingErrorCopy(err: unknown): BillingErrorCopy {
    const failure = describeBillingError(err);
    if (!failure) return {key: BILLING_GENERIC_ERROR_KEY, text: null};

    if (failure.code === BILLING_ERROR_CODES.stripeError && failure.detail) {
        return {key: null, text: failure.detail};
    }

    const key = failure.code === null ? null : ERROR_KEYS[failure.code] ?? null;
    return {key: key ?? BILLING_GENERIC_ERROR_KEY, text: null};
}
