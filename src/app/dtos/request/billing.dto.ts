import {BillingSubjectKind} from '../response/billing.dto';

/**
 * The two request bodies in `Echo/docs/specs/billing-checkout-api-contract.md`.
 *
 * <p>Both are small enough to have been inline object literals; they are named because the server
 * checks `ManageGuild` over the bus against exactly these three fields, and a typo in a literal
 * would arrive as a 400 that reads like a bug in the plan catalogue.</p>
 */

/** `POST /api/v1/billing/subscriptions`. */
export interface CreateSubscriptionRequest {
    planName: string;
    subjectKind: BillingSubjectKind;
    /** The guild id, or the caller's own user id for a user plan. */
    subjectId: string;
}

/** `POST /api/v1/billing/subscriptions/{id}/preview-change` and `.../change`, identically. */
export interface ChangePlanRequest {
    planName: string;
}
