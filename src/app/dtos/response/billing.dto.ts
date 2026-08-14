/**
 * The billing wire shapes, from `Echo/docs/specs/billing-checkout-api-contract.md`.
 *
 * <p>Every amount is <b>minor units</b> - `2900` is $29.00 - paired with a lowercase ISO 4217
 * `currency` from the same payload. There is no float anywhere in this contract in either
 * direction, and nothing here should ever be divided by 100 by hand; see `core/money.ts`.</p>
 *
 * <p>Timestamps are ISO 8601 UTC strings with a `Z`, left as strings rather than parsed on the way
 * in: the only thing this client does with them is format them, and a `Date` in a DTO is a value
 * that stops surviving a round trip through storage or a structured clone.</p>
 */

import {EntitlementRungDto, EntitlementValueDto} from './entitlement.dto';

/**
 * Which side of the product a plan is sold against.
 *
 * <p><b>Lowercase</b>, exactly as `EntitlementSubjectKind` in `entitlement.dto.ts` already is. The two payloads are
 * rendered by one screen, and the contract settled on one casing for that reason: two casings for
 * one concept on a single screen is a bug waiting for somebody to write `===`. Staff endpoints keep
 * PascalCase and are never compared here.</p>
 *
 * <p>Compare with {@link sameSubjectKind} rather than `===` anyway. The type is open, this client is
 * pointed at instances running older builds of the service, and a subscription that arrives as
 * `"Guild"` should still land on the guild screen rather than nowhere.</p>
 */
export type BillingSubjectKind = 'guild' | 'user' | (string & {});

/** How often a plan bills. Open, because a plan sold weekly or per quarter is a pricing decision. */
export type BillingInterval = 'month' | 'year' | (string & {});

/**
 * Whether two subject kinds name the same side of the product, whatever case they arrived in.
 *
 * <p>Blank is never equal to blank: an absent kind is not evidence that two payloads are about the
 * same thing, and treating it as one puts guild plans on an account screen.</p>
 */
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
    /**
     * Null for a plan that carries no price - which is how `free` and `free_user` arrive, and they
     * are present precisely so the comparison table can show what the paid tiers are compared to.
     * Null price and {@link purchasable} false always travel together.
     */
    priceMinorUnits: number | null;
    currency: string;
    interval: BillingInterval;
    /** False means the plan exists and is not sold. No buy button, but still a column. */
    purchasable: boolean;
    /**
     * What this plan resolves to, keyed by catalogue key.
     *
     * <p><b>Byte-identical to the entitlement snapshot's own `entitlements`</b>, and typed as the
     * same {@link EntitlementValueDto} rather than as a parallel shape. That is the whole point:
     * one renderer serves the comparison table and the limits screen, so the two cannot disagree
     * about what "unlimited" looks like. `unlimited: true` arrives with `value: null` because the
     * server's sentinel is `long.MaxValue`, which is past `Number.MAX_SAFE_INTEGER` and must never
     * cross the wire as a number.</p>
     */
    entitlements: Record<string, EntitlementValueDto>;
}

/**
 * What is for sale here, and whether anything is.
 *
 * <p>`enabled` is answered by the service that holds the secret key, which is the only place that
 * can answer it honestly. False means Stripe is not configured on this instance: `plans` is still
 * populated so the comparison renders, and every buy button is <b>absent</b> rather than disabled.
 * </p>
 *
 * <p>This is only one of the two gates. The other is a non-empty `stripePublishableKey()` from
 * {@link EntitlementStore}, and both have to be true before any purchasing surface exists.</p>
 */
export interface BillingCatalogueDto {
    enabled: boolean;
    /** The instance's selling currency. A plan still carries its own; prefer the plan's. */
    currency: string;
    plans: BillingPlanDto[];
    /**
     * Every ladder the plans above reference, lowest rung first - the same map the snapshot sends.
     *
     * <p>On the envelope and not on each plan, because a rung's metrics are a property of the
     * ladder rather than of who is buying. Optional here only so that a response from a service
     * that predates the field renders a comparison table instead of throwing.</p>
     */
    ladders?: Record<string, EntitlementRungDto[]>;
}

/**
 * Stripe's own subscription vocabulary, passed through unchanged rather than remapped.
 *
 * <p>Open on purpose. Stripe adds statuses, and a client that switches exhaustively over the set it
 * was built with crashes or renders blank the first time one arrives. Classify with
 * {@link subscriptionStanding} instead, which answers "needs attention" for anything it does not
 * recognise.</p>
 */
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

/**
 * The four answers a screen can actually branch on.
 *
 * <ul>
 *   <li>`live` - the subject has what they paid for. Renders as normal.</li>
 *   <li>`pending` - a payment is in flight and nothing is decided. This is the poll-and-wait state,
 *       and it is where a fresh `confirmPayment` lands until the webhook arrives.</li>
 *   <li>`attention` - money is owed or collection has stopped. Also the answer for every status
 *       this build does not recognise.</li>
 *   <li>`ended` - over, and not coming back without a new subscription.</li>
 * </ul>
 */
export type SubscriptionStanding = 'live' | 'pending' | 'attention' | 'ended';

/**
 * Which of the four a status is.
 *
 * <p>The default arm is the load-bearing one: an unrecognised status is `attention`, never `live`
 * and never a crash. Guessing `live` for an unknown value would hand out a tier on the strength of
 * a string nobody in this build has ever seen.</p>
 */
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
    /**
     * True after a cancel. Nothing has ended yet, and the copy has to say when access actually
     * stops - a subscription cancelled on day two of a month still has twenty-eight days of what
     * was paid for.
     */
    cancelAtPeriodEnd: boolean;
    /**
     * Non-null means a payment failed and the tier is being held until this moment.
     *
     * <p>The single most important field on the management screen for a customer whose card
     * expired, and it needs a plain sentence with a date rather than a status chip.</p>
     */
    gracePeriodEndsAt: string | null;
    priceMinorUnits: number;
    currency: string;
    /**
     * False means the caller manages the guild but somebody else's card is behind it. They may
     * look; they may not cancel, resume or change the plan.
     */
    isPayer: boolean;
}

/** What `POST /subscriptions` answers with. */
export interface CreateSubscriptionResponseDto {
    subscription: SubscriptionDto;
    /**
     * The Payment Element's client secret, or <b>null</b> when Stripe had nothing to confirm.
     *
     * <p>Null is a success, not an error: it means go straight to polling the subscription. A
     * client that treats it as a failure refuses a purchase that already worked.</p>
     *
     * <p><b>This is the only signal, and there is no `requiresAction` beside it.</b> An earlier
     * draft carried one and it was removable precisely because it was exactly `clientSecret !=
     * null` - two fields that can only ever agree are two fields that will eventually disagree,
     * and then nobody knows which is authoritative. This one is.</p>
     */
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

/** What `POST /payment-methods/setup-intent` answers with. Never null - there is always one. */
export interface SetupIntentDto {
    clientSecret: string;
}

/** One line of a proration preview. `amountMinorUnits` is negative for a credit. */
export interface ChangePreviewLineDto {
    description: string;
    amountMinorUnits: number;
}

/**
 * What changing plan would cost, before it is committed.
 *
 * <p>Proration is the single most frequent billing support question, and showing this first is what
 * removes most of it. `immediateChargeMinorUnits` <b>can be negative</b>, which is a credit rather
 * than a charge and reads as one.</p>
 */
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
