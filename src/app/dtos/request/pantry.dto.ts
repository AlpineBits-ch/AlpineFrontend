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
    /** The product code, when the row is being created from a scan. */
    barcode?: string | null;
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
    barcode?: string;
    /** Unlearns this row's code. Same flag rule as the two above. */
    clearBarcode?: boolean;
}

// ── Capture ─────────────────────────────────────────────────────────────────
//
// The three one-tap ways to change stock. The pantry's problem was never missing features, it was
// that keeping a decimal quantity correct by hand is itself a chore. Everything here exists to make
// the common change cost one tap and no typing, which is why every field but the code is optional.

/**
 * A scan.
 *
 * <p>After the first scan of a product everything but {@link barcode} is usually absent, and that is
 * the entire point of the guild learning its own codes. Send {@link name} only when the response to
 * the previous attempt said the code was unknown, or to correct a label - which re-teaches it.</p>
 */
export interface ScanPantryItemDto {
    barcode: string;
    /** How much this scan adds. Absent falls back to what the house learned, then to 1. */
    quantity?: number;
    /** Required only the first time a code is seen in this guild. */
    name?: string;
    unit?: string;
    expiresAt?: string;
}

/** "Used it up." The tap the module was missing. */
export interface ConsumePantryItemDto {
    /** Defaults to 1, and never takes the quantity below zero. */
    amount?: number;
    /**
     * Sets the quantity to zero outright, for the far commoner "that was the last of it" - which a
     * client cannot express as an amount without first knowing the exact stock.
     */
    all?: boolean;
}

/** "Put some back." Defaults to 1, and ticks off the shopping-list line the pantry created. */
export interface RestockPantryItemDto {
    amount?: number;
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
