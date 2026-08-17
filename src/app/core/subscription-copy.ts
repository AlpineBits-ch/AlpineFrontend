import {
    BillingInterval,
    ChangePreviewDto,
    SubscriptionStanding,
    SubscriptionStatus,
    subscriptionStanding,
} from '../dtos/response/billing.dto';
import {formatMinor} from './money';

/** Every table here must use literal keys; `i18n-keys.spec.ts` cannot see a computed one. */

const STANDING_KEYS: Record<SubscriptionStanding, string> = {
    live: 'BILLING.SUBSCRIPTION.STANDING.LIVE',
    pending: 'BILLING.SUBSCRIPTION.STANDING.PENDING',
    attention: 'BILLING.SUBSCRIPTION.STANDING.ATTENTION',
    ended: 'BILLING.SUBSCRIPTION.STANDING.ENDED',
};

/** Stripe's invoice statuses, which are a different vocabulary from a subscription's. */
const INVOICE_STATUS_KEYS: Record<string, string> = {
    draft: 'BILLING.INVOICE.STATUS.DRAFT',
    open: 'BILLING.INVOICE.STATUS.OPEN',
    paid: 'BILLING.INVOICE.STATUS.PAID',
    uncollectible: 'BILLING.INVOICE.STATUS.UNCOLLECTIBLE',
    void: 'BILLING.INVOICE.STATUS.VOID',
};

/** How often a price is charged, in the form that follows an amount: "$29.00 per month". */
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

/** The word for a subscription's status, routed through {@link subscriptionStanding}. */
export function standingLabelKey(status: SubscriptionStatus): string {
    return STANDING_KEYS[subscriptionStanding(status)];
}

export function invoiceStatusKey(status: string): string {
    return INVOICE_STATUS_KEYS[(status ?? '').trim().toLowerCase()] ?? 'BILLING.INVOICE.STATUS.OTHER';
}

/** The "per month" that follows a price, or null when the cadence is absent or unrecognised. */
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

/** What a subscription costs, said as a rate rather than as a bare number. */
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

/** An ISO timestamp as a date in the reader's own locale, or null when it is not one. */
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
    /** Always the absolute amount. The direction is carried by the words, not by a sign. */
    amount: string;
    direction: 'charge' | 'credit' | 'none';
}

/** What happens to the customer's money the moment they confirm. Zero is its own direction. */
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

/** A preview's line items, in the order the server sent them. Never reorder or sum them here. */
export function previewLineCopy(preview: ChangePreviewDto, locale?: string): PreviewLineCopy[] {
    return (preview.lines ?? []).map(line => ({
        description: line.description,
        amount: formatMinor(line.amountMinorUnits, preview.currency, locale),
        credit: line.amountMinorUnits < 0,
    }));
}
