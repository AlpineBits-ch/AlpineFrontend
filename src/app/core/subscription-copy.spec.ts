import {describe, expect, it} from 'vitest';
import en from '../../assets/i18n/locales/en.json';
import {ChangePreviewDto} from '../dtos/response/billing.dto';
import {
    BILLING_SUBSCRIPTION_TRANSLATION_KEYS,
    formatBillingDate,
    immediateAmountCopy,
    intervalLabelKey,
    invoiceStatusKey,
    previewLineCopy,
    standingLabelKey,
    subscriptionPriceCopy,
} from './subscription-copy';

function preview(over: Partial<ChangePreviewDto> = {}): ChangePreviewDto {
    return {
        immediateChargeMinorUnits: 1450,
        currency: 'usd',
        nextInvoiceTotalMinorUnits: 900,
        nextInvoiceAt: '2026-09-14T10:12:00Z',
        lines: [],
        ...over,
    };
}

describe('the word for a subscription status', () => {
    it('names the two statuses that mean the customer has what they paid for', () => {
        expect(standingLabelKey('active')).toBe('BILLING.SUBSCRIPTION.STANDING.LIVE');
        expect(standingLabelKey('trialing')).toBe('BILLING.SUBSCRIPTION.STANDING.LIVE');
    });

    it('separates money owed from a subscription that is over', () => {
        expect(standingLabelKey('past_due')).toBe('BILLING.SUBSCRIPTION.STANDING.ATTENTION');
        expect(standingLabelKey('canceled')).toBe('BILLING.SUBSCRIPTION.STANDING.ENDED');
        expect(standingLabelKey('incomplete')).toBe('BILLING.SUBSCRIPTION.STANDING.PENDING');
    });

    /**
     * The load-bearing case. Stripe adds statuses, and guessing "active" for one nobody in this
     * build has ever seen would put a paid-for badge on a subscription on the strength of a string.
     */
    it('reads a status from a newer Stripe as needing attention, never as active', () => {
        expect(standingLabelKey('quantum_paused')).toBe('BILLING.SUBSCRIPTION.STANDING.ATTENTION');
        expect(standingLabelKey('')).toBe('BILLING.SUBSCRIPTION.STANDING.ATTENTION');
    });
});

describe('the word for an invoice status', () => {
    it('translates the statuses Stripe actually sends', () => {
        expect(invoiceStatusKey('paid')).toBe('BILLING.INVOICE.STATUS.PAID');
        expect(invoiceStatusKey('open')).toBe('BILLING.INVOICE.STATUS.OPEN');
        expect(invoiceStatusKey('void')).toBe('BILLING.INVOICE.STATUS.VOID');
    });

    it('is not thrown by casing or padding on the wire', () => {
        expect(invoiceStatusKey(' Paid ')).toBe('BILLING.INVOICE.STATUS.PAID');
    });

    /** "uncollectible" is Stripe's word. It is not one to put in front of somebody's own receipts. */
    it('never renders the raw token for a status this build has no word for', () => {
        expect(invoiceStatusKey('disputed')).toBe('BILLING.INVOICE.STATUS.OTHER');
        expect(invoiceStatusKey('')).toBe('BILLING.INVOICE.STATUS.OTHER');
    });
});

describe('the date in a sentence about money', () => {
    it('renders the day, month and year in the reader locale', () => {
        expect(formatBillingDate('2026-09-14T10:12:00Z', 'long', 'en-GB')).toBe('14 September 2026');
    });

    /**
     * Asserted as "shorter than the long form" rather than against a literal: which abbreviation
     * ICU uses for a month is a data-table decision that moves between runtimes, and pinning it
     * would make this spec a test of the Node build rather than of this function.
     */
    it('abbreviates for the invoice table, where the column is scanned rather than read', () => {
        const short = formatBillingDate('2026-09-14T10:12:00Z', 'short', 'en-GB') ?? '';
        const long = formatBillingDate('2026-09-14T10:12:00Z', 'long', 'en-GB') ?? '';

        expect(short).toContain('14');
        expect(short).toContain('2026');
        expect(short.length).toBeLessThan(long.length);
    });

    /**
     * Null rather than "Invalid Date": every caller builds a sentence around this, and a sentence
     * with a broken date in the middle is worse than one that does not name a day at all.
     */
    it('answers null for anything that is not a date', () => {
        expect(formatBillingDate(null)).toBeNull();
        expect(formatBillingDate(undefined)).toBeNull();
        expect(formatBillingDate('')).toBeNull();
        expect(formatBillingDate('not a timestamp')).toBeNull();
    });
});

describe('what a subscription costs, said as a rate', () => {
    it('puts the cadence beside the amount', () => {
        const copy = subscriptionPriceCopy(2900, 'usd', 'month', 'en-US');

        expect(copy.amount).toBe('$29.00');
        expect(copy.intervalKey).toBe('BILLING.INTERVAL.MONTH');
    });

    it('says per year for an annual plan', () => {
        expect(subscriptionPriceCopy(29000, 'usd', 'year').intervalKey).toBe('BILLING.INTERVAL.YEAR');
    });

    /**
     * Null is the server saying the plan version could not be resolved. The amount still stands on
     * its own; what must not happen is "per null" or a trailing blank where a word belongs.
     */
    it('falls back to the amount alone when the interval is null', () => {
        const copy = subscriptionPriceCopy(2900, 'usd', null, 'en-US');

        expect(copy.amount).toBe('$29.00');
        expect(copy.intervalKey).toBeNull();
    });

    /** The rolling-deploy case: this build talks to servers that predate the field entirely. */
    it('falls back the same way when the field is absent', () => {
        const copy = subscriptionPriceCopy(2900, 'usd', undefined, 'en-US');

        expect(copy.amount).toBe('$29.00');
        expect(copy.intervalKey).toBeNull();
    });

    /**
     * A quarterly price billed as "per month" on screen is a wrong statement about what somebody is
     * being charged, which is worse than an incomplete one.
     */
    it('guesses nothing for a cadence this build has no word for', () => {
        expect(intervalLabelKey('quarter')).toBeNull();
        expect(intervalLabelKey('')).toBeNull();
        expect(intervalLabelKey(null)).toBeNull();
        expect(intervalLabelKey(undefined)).toBeNull();
    });

    it('is not thrown by casing or padding on the wire', () => {
        expect(intervalLabelKey(' Month ')).toBe('BILLING.INTERVAL.MONTH');
    });

    /** A price the server did not name is not a zero, and "$0.00 per month" reads as free. */
    it('names no amount where the server named no price', () => {
        expect(subscriptionPriceCopy(null, 'usd', 'month').amount).toBeNull();
        expect(subscriptionPriceCopy(undefined, null, 'month').amount).toBeNull();
    });
});

describe('what the customer is about to be charged, or given back', () => {
    it('says charged, in words, for a positive amount', () => {
        const copy = immediateAmountCopy(1450, 'usd', 'en-US');

        expect(copy.direction).toBe('charge');
        expect(copy.key).toBe('BILLING.CHANGE.CHARGE_NOW');
        expect(copy.amount).toBe('$14.50');
    });

    /**
     * The whole reason this helper exists. A bare "-5.00" sits directly above a list of preview
     * lines that are also negative for a different reason, so the one number that says which way
     * the money moves would be the one number on the screen that cannot be read on its own.
     */
    it('says credited, in words, and drops the sign from the figure', () => {
        const copy = immediateAmountCopy(-500, 'usd', 'en-US');

        expect(copy.direction).toBe('credit');
        expect(copy.key).toBe('BILLING.CHANGE.CREDIT_NOW');
        expect(copy.amount).toBe('$5.00');
        expect(copy.amount).not.toContain('-');
    });

    /** A switch between two equally priced plans lands here, and "charged 0.00" reads as a bug. */
    it('has its own answer for a change that costs nothing today', () => {
        const copy = immediateAmountCopy(0, 'usd', 'en-US');

        expect(copy.direction).toBe('none');
        expect(copy.key).toBe('BILLING.CHANGE.NO_CHARGE');
    });

    /** The exponent comes from the currency. 2900 JPY is not 29.00 of anything. */
    it('respects a currency with no minor unit', () => {
        expect(immediateAmountCopy(2900, 'jpy', 'en-US').amount).toBe('¥2,900');
    });
});

describe('the proration lines', () => {
    it('keeps the sign, so a credit line reads as one without the colour having to say it', () => {
        const lines = previewLineCopy(
            preview({
                lines: [
                    {description: 'Unused time on Pro', amountMinorUnits: -1450},
                    {description: 'Remaining time on Plus', amountMinorUnits: 450},
                ],
            }),
            'en-US',
        );

        expect(lines[0].amount).toContain('14.50');
        expect(lines[0].amount).toContain('-');
        expect(lines[0].credit).toBe(true);
        expect(lines[1].credit).toBe(false);
    });

    /** Order is Stripe's reading of the change, and nothing here re-sums it into a total. */
    it('leaves the order and the descriptions exactly as sent', () => {
        const lines = previewLineCopy(
            preview({
                lines: [
                    {description: 'B', amountMinorUnits: 1},
                    {description: 'A', amountMinorUnits: 2},
                ],
            }),
        );

        expect(lines.map(l => l.description)).toEqual(['B', 'A']);
    });

    it('renders no lines at all for a preview that carried none', () => {
        expect(previewLineCopy(preview({lines: []}))).toEqual([]);
    });
});

describe('the subscription keys', () => {
    /** Held in a table and handed to `translate` as a variable, so no other spec can see them. */
    it('all resolve in en.json', () => {
        const strings = en as Record<string, string>;
        const missing = BILLING_SUBSCRIPTION_TRANSLATION_KEYS.filter(key => !(key in strings));

        expect(BILLING_SUBSCRIPTION_TRANSLATION_KEYS.length).toBeGreaterThan(10);
        expect(missing, `keys held in a table but absent from en.json:\n${missing.join('\n')}`).toEqual([]);
    });
});
