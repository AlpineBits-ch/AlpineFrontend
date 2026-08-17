/**
 * `POST /api/v1/billing/credit/me/purchases`.
 *
 * <p>The wallet is always the caller's - it comes off the token and is never a field - so the only
 * thing this names is what is being bought and where it goes.</p>
 */
export interface PurchaseCreditRequest {
    /** The SKU's stable code, matched case-insensitively by the server. */
    sku: string;
    /**
     * The guild a guild-scoped SKU applies to, or null for a user-scoped one.
     *
     * <p>Null is not a shorthand for "me" that the server has to guess at: a user SKU is always
     * applied to the buyer, and a guild SKU with no target is refused with `target_required`.</p>
     */
    targetId: string | null;
    /**
     * What makes a retry the same purchase rather than a second one.
     *
     * <p><b>Minted once per dialog, never per press.</b> A key regenerated on each submit turns the
     * retry after a dropped connection into a second purchase at full price - which is the one
     * failure the server's idempotency table exists to make impossible, and the client is the half
     * that decides whether it works.</p>
     */
    idempotencyKey: string;
}
