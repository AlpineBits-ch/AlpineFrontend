/**
 * Pantry write bodies. Separate from the response shapes because the two differ in the
 * ways that matter: the server owns `isLow` and `restockedAt` (they are outputs of the
 * restock loop, never inputs), and `id` / `channelId` / `addedByUserId` come from the
 * route and the session.
 */

export interface CreatePantryItemDto {
    name: string;
    /** Decimal - see PantryItem.quantity. */
    quantity: number;
    unit?: string | null;
    /** Omit or send `null` to leave restock tracking off for this item; `0` is a real threshold. */
    lowThreshold?: number | null;
    /** ISO-8601. */
    expiresAt?: string | null;
}

/**
 * A partial patch: only the keys present are written.
 *
 * <p>Which is why clearing is a **flag**, not a `null`. The server's rule is
 * `if (dto.X is not null) item.X = dto.X` - a nullable field sent as `null` reads as *leave
 * alone*, so there is no value of `lowThreshold` or `expiresAt` that means "switch this
 * off". The two `clear*` booleans are the only way to express it, and they win over the
 * value field when both are sent. Sending `null` instead is the bug this shape exists to
 * make untypeable.</p>
 */
export interface UpdatePantryItemDto {
    name?: string;
    quantity?: number;
    /**
     * `null` is *not* how you remove a unit - the server would leave the old one. Send `''`,
     * which it stores verbatim and every reader treats as absent.
     */
    unit?: string;
    /**
     * The new threshold. `0` is a real value meaning "chase it when it runs out", so this is
     * never conflated with absence; use {@link clearLowThreshold} to turn tracking off.
     */
    lowThreshold?: number;
    /** Turns restock tracking off for this item. Overrides `lowThreshold` if both are sent. */
    clearLowThreshold?: boolean;
    /** ISO-8601. */
    expiresAt?: string;
    /** Removes the expiry date. Overrides `expiresAt` if both are sent. */
    clearExpiresAt?: boolean;
}

/**
 * The config write. `expiryWarningDays` is always sent - a partial write would leave the
 * caller guessing which half survived - but the restock list follows the same flag rule as
 * the item patch: **omit** `restockListChannelId` and send `clearRestockList: true` to
 * switch the loop off, rather than sending a `null` id.
 */
export interface UpdatePantryConfigDto {
    /** Must be a List channel in this guild, or the server answers `400`. */
    restockListChannelId?: string;
    /** Switches the restock loop off for this pantry. Suppresses `restockListChannelId`. */
    clearRestockList?: boolean;
    /** 1-90. Validated client-side so a slider typo is not a round trip. */
    expiryWarningDays: number;
}
