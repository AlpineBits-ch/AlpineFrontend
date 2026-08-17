import {describe, expect, it} from 'vitest';
import {HttpErrorResponse} from '@angular/common/http';
import en from '../../assets/i18n/locales/en.json';
import {BILLING_ERROR_TRANSLATION_KEYS, BILLING_GENERIC_ERROR_KEY, billingErrorCopy} from './billing-copy';

function problem(status: number, body: unknown): HttpErrorResponse {
    return new HttpErrorResponse({status, error: body});
}

describe('billingErrorCopy - the named refusals', () => {
    it('names the one refusal on the cards screen a person can act on', () => {
        const copy = billingErrorCopy(problem(409, {code: 'last_payment_method'}));

        expect(copy.key).toBe('BILLING.ERROR.LAST_PAYMENT_METHOD');
        expect(copy.text).toBeNull();
    });

    it('covers the codes the contract added after the service layer was written', () => {
        expect(billingErrorCopy(problem(403, {code: 'not_the_payer'})).key).toBe(
            'BILLING.ERROR.NOT_THE_PAYER',
        );
        expect(billingErrorCopy(problem(409, {code: 'subscription_lapsed'})).key).toBe(
            'BILLING.ERROR.SUBSCRIPTION_LAPSED',
        );
    });

    it('offers the change-plan wording rather than the code for an existing subscription', () => {
        expect(billingErrorCopy(problem(409, {code: 'already_subscribed'})).key).toBe(
            'BILLING.ERROR.ALREADY_SUBSCRIBED',
        );
    });
});

describe('billingErrorCopy - Stripe speaking for itself', () => {
    /** Stripe's detail is written for cardholders. Ours would be a guess at which decline it was. */
    it('shows the provider sentence verbatim on a stripe_error', () => {
        const copy = billingErrorCopy(
            problem(502, {code: 'stripe_error', detail: 'Your card was declined.'}),
        );

        expect(copy.text).toBe('Your card was declined.');
        expect(copy.key).toBeNull();
    });

    it('falls back to our own sentence when the 502 carried no detail', () => {
        const copy = billingErrorCopy(problem(502, {code: 'stripe_error'}));

        expect(copy.key).toBe('BILLING.ERROR.STRIPE');
        expect(copy.text).toBeNull();
    });
});

describe('billingErrorCopy - what it does with what it does not know', () => {
    /** This table will grow. A build that predates a code must still say something usable. */
    it('degrades a code from a newer service to the generic sentence', () => {
        const copy = billingErrorCopy(problem(409, {code: 'quota_exhausted'}));

        expect(copy.key).toBe(BILLING_GENERIC_ERROR_KEY);
        // Never the raw code, and never the status: "409" is not a sentence.
        expect(copy.text).toBeNull();
    });

    it('degrades a response that is not problem+json at all', () => {
        expect(billingErrorCopy(problem(500, '<html>502 Bad Gateway</html>')).key).toBe(
            BILLING_GENERIC_ERROR_KEY,
        );
    });

    it('degrades something that is not an HTTP failure, which is how Stripe.js fails', () => {
        expect(billingErrorCopy(new Error('boom')).key).toBe(BILLING_GENERIC_ERROR_KEY);
        expect(billingErrorCopy(null).key).toBe(BILLING_GENERIC_ERROR_KEY);
        expect(billingErrorCopy(undefined).key).toBe(BILLING_GENERIC_ERROR_KEY);
    });
});

describe('the billing error keys', () => {
    /** Held in a table and handed to `translate` as a variable, so no other spec can see them. */
    it('all resolve in en.json', () => {
        const strings = en as Record<string, string>;
        const missing = BILLING_ERROR_TRANSLATION_KEYS.filter(key => !(key in strings));

        expect(BILLING_ERROR_TRANSLATION_KEYS.length).toBeGreaterThan(5);
        expect(missing).toEqual([]);
    });
});
