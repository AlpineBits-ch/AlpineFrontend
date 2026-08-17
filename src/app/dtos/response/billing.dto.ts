/**
 * The billing wire shapes, from `Echo/docs/specs/billing-checkout-api-contract.md`. Every amount is
 * minor units (2900 is $29.00) with a lowercase ISO 4217 `currency`; timestamps are ISO 8601 UTC.
 */

import {EntitlementRungDto, EntitlementValueDto} from './entitlement.dto';

/** Which side of the product a plan is sold against. Lowercase on the wire; compare with {@link sameSubjectKind}. */
export type BillingSubjectKind = 'guild' | 'user' | (string & {});

/** How often a plan bills. Open, because a plan sold weekly or per quarter is a pricing decision. */
export type BillingInterval = 'month' | 'year' | (string & {});

/** Whether two subject kinds name the same side of the product, whatever case. Blank never matches blank. */
export function sameSubjectKind(
    left: BillingSubjectKind | null | undefined,
    right: BillingSubjectKind | null | undefined,
): boolean {
    const a = left?.trim().toLowerCase() ?? '';
    const b = right?.trim().toLowerCase() ?? '';
    return a.length > 0 && a === b;
}

/** One sellable thing, plus the numbers a comparison table needs to justify its price. */
export interface BillingPlanDto {
    /** The key. Stable, and the thing to branch on. Never rendered. */
    name: string;
    displayName: string;
    description: string;
    versionNumber: number;
    subjectKind: BillingSubjectKind;
    /** Null for a plan that carries no price. Null price and {@link purchasable} false always travel together. */
    priceMinorUnits: number | null;
    currency: string;
    interval: BillingInterval;
    /** False means the plan exists and is not sold. No buy button, but still a column. */
    purchasable: boolean;
    /**
     * What this plan resolves to, keyed by catalogue key. Byte-identical to the entitlement
     * snapshot's own `entitlements`; `unlimited: true` always arrives with `value: null`.
     */
    entitlements: Record<string, EntitlementValueDto>;
}

/**
 * What is for sale here, and whether anything is. `enabled` false means Stripe is not configured;
 * `plans` still populates, and a purchasing surface also needs a non-empty `stripePublishableKey()`.
 */
export interface BillingCatalogueDto {
    enabled: boolean;
    /** The instance's selling currency. A plan still carries its own; prefer the plan's. */
    currency: string;
    plans: BillingPlanDto[];
    /** Every ladder the plans above reference, lowest rung first. The same map the snapshot sends. */
    ladders?: Record<string, EntitlementRungDto[]>;
}

/** Stripe's own subscription vocabulary, passed through unchanged. Classify with {@link subscriptionStanding}. */
export type SubscriptionStatus =
    | 'incomplete'
    | 'incomplete_expired'
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'unpaid'
    | 'paused'
    | (string & {});

/** The four answers a screen can branch on: paid up, payment in flight, money owed, or over. */
export type SubscriptionStanding = 'live' | 'pending' | 'attention' | 'ended';

/** Which of the four a status is. An unrecognised status is `attention`, never `live`. */
export function subscriptionStanding(status: SubscriptionStatus): SubscriptionStanding {
    switch (status) {
        case 'active':
        case 'trialing':
            return 'live';
        case 'incomplete':
            return 'pending';
        case 'incomplete_expired':
        case 'canceled':
            return 'ended';
        case 'past_due':
        case 'unpaid':
        case 'paused':
        default:
            return 'attention';
    }
}

/** One subscription, as the caller is allowed to see it. */
export interface SubscriptionDto {
    id: string;
    subjectKind: BillingSubjectKind;
    subjectId: string;
    planName: string;
    planDisplayName: string;
    versionNumber: number;
    status: SubscriptionStatus;
    currentPeriodEnd: string;
    /** True after a cancel. Nothing has ended yet; access stops at `currentPeriodEnd`. */
    cancelAtPeriodEnd: boolean;
    /** Non-null means a payment failed and the tier is being held until this moment. */
    gracePeriodEndsAt: string | null;
    priceMinorUnits: number;
    currency: string;
    /** How often that price is charged. Null means the plan version could not be resolved; absent means an older server. */
    interval?: BillingInterval | null;
    /** False means somebody else's card is behind the subscription: read-only for this caller. */
    isPayer: boolean;
}

/** What `POST /subscriptions` answers with. */
export interface CreateSubscriptionResponseDto {
    subscription: SubscriptionDto;
    /** The Payment Element's client secret, or null when Stripe had nothing to confirm. Null is a success. */
    clientSecret: string | null;
}

/** Brand, last four and expiry are the only card data that exists on our side, by design. */
export interface PaymentMethodDto {
    id: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    isDefault: boolean;
}

/** What `POST /payment-methods/setup-intent` answers with. Never null; there is always one. */
export interface SetupIntentDto {
    clientSecret: string;
}

/** One line of a proration preview. `amountMinorUnits` is negative for a credit. */
export interface ChangePreviewLineDto {
    description: string;
    amountMinorUnits: number;
}

/** What changing plan would cost, before it is committed. `immediateChargeMinorUnits` can be negative, meaning a credit. */
export interface ChangePreviewDto {
    immediateChargeMinorUnits: number;
    currency: string;
    nextInvoiceTotalMinorUnits: number;
    nextInvoiceAt: string;
    lines: ChangePreviewLineDto[];
}

/** One invoice. The two URLs are opened externally; we do not render invoices. */
export interface InvoiceDto {
    id: string;
    number: string;
    status: string;
    amountDueMinorUnits: number;
    currency: string;
    createdAt: string;
    hostedInvoiceUrl: string;
    invoicePdfUrl: string;
}
