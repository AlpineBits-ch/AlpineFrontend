import {
    BillingInterval,
    ChangePreviewDto,
    SubscriptionStanding,
    SubscriptionStatus,
    subscriptionStanding,
} from '../dtos/response/billing.dto';
import {formatMinor} from './money';

/**
 * What a subscription management screen is allowed to say, as literal translation keys.
 *
 * <p>The same argument as `billing-copy.ts` makes about refusals applies to every other server
 * vocabulary on these screens: `'BILLING.SUBSCRIPTION.STANDING.' + standing` is the obvious spelling
 * and is exactly what `i18n-keys.spec.ts` cannot see, so a renamed key would render raw to a
 * customer with every test in this repo green. Tables of literals, exported for a spec to walk.</p>
 */

const STANDING_KEYS: Record<SubscriptionStanding, string> = {
    live: 'BILLING.SUBSCRIPTION.STANDING.LIVE',
    pending: 'BILLING.SUBSCRIPTION.STANDING.PENDING',
    attention: 'BILLING.SUBSCRIPTION.STANDING.ATTENTION',
    ended: 'BILLING.SUBSCRIPTION.STANDING.ENDED',
};

/**
 * Stripe's invoice statuses, which are a different vocabulary from a subscription's.
 *
 * <p>Open, like every other one: an unrecognised value gets a word that admits it rather than the
 * raw token. `"uncollectible"` is Stripe's, not ours, and is not a word to put in front of somebody
 * who is looking at their own receipts.</p>
 */
const INVOICE_STATUS_KEYS: Record<string, string> = {
    draft: 'BILLING.INVOICE.STATUS.DRAFT',
    open: 'BILLING.INVOICE.STATUS.OPEN',
    paid: 'BILLING.INVOICE.STATUS.PAID',
    uncollectible: 'BILLING.INVOICE.STATUS.UNCOLLECTIBLE',
    void: 'BILLING.INVOICE.STATUS.VOID',
};

/**
 * How often a price is charged, in the form that follows an amount: "$29.00 <b>per month</b>".
 *
 * <p>A table rather than a ternary, because the set is open. A plan sold weekly or per quarter is a
 * pricing decision somebody can make on the server, and `interval === 'year' ? YEAR : MONTH` would
 * quietly bill it monthly on screen.</p>
 */
const INTERVAL_KEYS: Record<string, string> = {
    month: 'BILLING.INTERVAL.MONTH',
    year: 'BILLING.INTERVAL.YEAR',
};

/** What an immediate proration amount is, said in words rather than left to a minus sign. */
const IMMEDIATE_KEYS = {
    charge: 'BILLING.CHANGE.CHARGE_NOW',
    credit: 'BILLING.CHANGE.CREDIT_NOW',
    none: 'BILLING.CHANGE.NO_CHARGE',
} as const;

/** For the spec that proves every key this file can produce resolves in en.json. */
export const BILLING_SUBSCRIPTION_TRANSLATION_KEYS: readonly string[] = [
    ...Object.values(STANDING_KEYS),
    ...Object.values(INVOICE_STATUS_KEYS),
    ...Object.values(INTERVAL_KEYS),
    ...Object.values(IMMEDIATE_KEYS),
    'BILLING.INVOICE.STATUS.OTHER',
];

/**
 * The word for a subscription's status.
 *
 * <p>Routed through {@link subscriptionStanding}, so a status Stripe adds after this build shipped
 * reads as "needs attention" - never as "active", and never as a crash.</p>
 */
export function standingLabelKey(status: SubscriptionStatus): string {
    return STANDING_KEYS[subscriptionStanding(status)];
}

export function invoiceStatusKey(status: string): string {
    return INVOICE_STATUS_KEYS[(status ?? '').trim().toLowerCase()] ?? 'BILLING.INVOICE.STATUS.OTHER';
}

/**
 * The "per month" that follows a price, or <b>null</b> when there is nothing honest to put there.
 *
 * <p>Null in three cases, and all three are real:</p>
 *
 * <ul>
 *   <li><b>The server sent null.</b> `interval` is null exactly when the plan version could not be
 *       resolved, which is the same condition that empties the price - a version nobody can find has
 *       no period to state.</li>
 *   <li><b>The server sent nothing at all.</b> The field is new, and during a rolling deploy this
 *       client talks to builds that predate it.</li>
 *   <li><b>The interval is one this build has no word for.</b> Guessing "month" for a quarterly
 *       price is worse than saying only the amount: it is a wrong statement about what somebody is
 *       being charged, rather than an incomplete one.</li>
 * </ul>
 *
 * <p>Every one of them degrades to the amount on its own, which is what this screen said before the
 * field existed. Nothing renders "per null" and nothing renders a trailing blank.</p>
 */
export function intervalLabelKey(interval: BillingInterval | null | undefined): string | null {
    return INTERVAL_KEYS[(interval ?? '').trim().toLowerCase()] ?? null;
}

/** A price and the cadence it is charged at, ready for a template to put side by side. */
export interface SubscriptionPriceCopy {
    /** Formatted in the payload's own currency. Null where the server named no price. */
    amount: string | null;
    /** A key reading "per month". Null where the cadence is unknown; see {@link intervalLabelKey}. */
    intervalKey: string | null;
}

/**
 * What a subscription costs, said as a rate rather than as a bare number.
 *
 * <p>"$29.00" and a renewal date leaves the reader to infer the cadence from the gap between two
 * dates they cannot both see, and gets it wrong on an annual plan bought last week. "$29.00 per
 * month" states it. Where the cadence is not known the amount stands alone rather than being
 * decorated with a guess.</p>
 */
export function subscriptionPriceCopy(
    priceMinorUnits: number | null | undefined,
    currency: string | null | undefined,
    interval: BillingInterval | null | undefined,
    locale?: string,
): SubscriptionPriceCopy {
    const amount = typeof priceMinorUnits === 'number' && Number.isFinite(priceMinorUnits)
        ? formatMinor(priceMinorUnits, currency ?? '', locale)
        : null;

    return {amount, intervalKey: intervalLabelKey(interval)};
}

/**
 * An ISO timestamp as a date in the reader's own locale, or null when it is not one.
 *
 * <p>Null rather than "Invalid Date": every caller here is building a sentence around the date, and
 * a sentence with a broken date in the middle of it is worse than the sentence being absent.</p>
 *
 * <p>`long` for prose - "3 March 2026" inside a sentence about money - and `short` for the invoice
 * table, where the column is scanned rather than read.</p>
 */
export function formatBillingDate(
    iso: string | null | undefined,
    style: 'long' | 'short' = 'long',
    locale?: string,
): string | null {
    if (!iso) return null;
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return null;

    return new Intl.DateTimeFormat(locale, {
        day: 'numeric',
        month: style === 'long' ? 'long' : 'short',
        year: 'numeric',
    }).format(at);
}

/** The headline of a proration preview: which direction the money moves, and how much. */
export interface ImmediateAmountCopy {
    /** A sentence key taking `{amount}`. */
    key: string;
    /** Always the <b>absolute</b> amount. The direction is carried by the words, not by a sign. */
    amount: string;
    direction: 'charge' | 'credit' | 'none';
}

/**
 * What happens to the customer's money the moment they confirm.
 *
 * <p>The absolute value with a direction in words, deliberately. `immediateChargeMinorUnits` is
 * negative for a credit, and a bare `-5.00` sits directly above a list of line items that are also
 * negative for a different reason - so the one number that says whether they are about to be charged
 * or refunded would be the one number on the screen that cannot be read on its own.</p>
 *
 * <p>Zero is its own answer rather than a charge of nothing: a switch between two plans of the same
 * price mid-period lands there, and "you will be charged 0.00 now" reads as a bug.</p>
 */
export function immediateAmountCopy(
    amountMinorUnits: number,
    currency: string,
    locale?: string,
): ImmediateAmountCopy {
    const direction = amountMinorUnits > 0 ? 'charge' : amountMinorUnits < 0 ? 'credit' : 'none';
    return {
        key: IMMEDIATE_KEYS[direction],
        amount: formatMinor(Math.abs(amountMinorUnits), currency, locale),
        direction,
    };
}

/** One preview line, formatted. The sign stays: a line is a credit or a charge on its own terms. */
export interface PreviewLineCopy {
    description: string;
    amount: string;
    /** Kept beside the string so the template can label a credit rather than only colour it. */
    credit: boolean;
}

/**
 * A preview's line items, in the order the server sent them.
 *
 * <p>Not reordered and not summed here. The order is Stripe's own reading of the change - what was
 * given back, then what was taken - and a total computed on this side that disagreed with
 * `immediateChargeMinorUnits` by one minor unit would be a support ticket about being overcharged.
 * </p>
 */
export function previewLineCopy(preview: ChangePreviewDto, locale?: string): PreviewLineCopy[] {
    return (preview.lines ?? []).map(line => ({
        description: line.description,
        amount: formatMinor(line.amountMinorUnits, preview.currency, locale),
        credit: line.amountMinorUnits < 0,
    }));
}
