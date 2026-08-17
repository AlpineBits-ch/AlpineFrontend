/**
 * Pantry: the stock held in one location. One Pantry channel is one location, so thresholds and
 * restock wiring are per channel. The server performs the restock append, never this client.
 */

/** One line of stock. */
export interface PantryItem {
    id: string;
    /** The Pantry channel. An item never moves between pantries; edit means delete + add. */
    channelId: string;
    name: string;
    /** A decimal, unlike the List module's free-text `quantity`. Never widen this to `string`. */
    quantity: number;
    /** Free text ("kg", "bottles"). Purely a label; nothing is converted or compared by it. */
    unit?: string | null;
    /**
     * The restock trigger, or `null` for restock tracking off. `0` is a real threshold, so test
     * with `== null` / `!= null` and never a falsy check.
     */
    lowThreshold?: number | null;
    /** ISO-8601. `null` for anything that doesn't go off. */
    expiresAt?: string | null;
    /** The server's own answer to "is this at or under its threshold". Reported even when the loop is off. */
    isLow: boolean;
    /** Set while the item is sitting on the shopping list, cleared when it is not. Recompute, never latch. */
    restockedAt?: string | null;
    /** The product code this row was last scanned under. Learned per guild; there is no third-party lookup. */
    barcode?: string | null;
    addedByUserId: string;
}

/** What a scan did, which cannot be inferred from the item alone. {@link learned} is the only one worth interrupting for. */
export interface ScanPantryItemResult {
    item: PantryItem;
    /** A new row, rather than a top-up of the jar that was already there. Different confirmations. */
    created: boolean;
    /** The code was unknown and its name has now been learned. See the type doc. */
    learned: boolean;
}

/** One code the house has learned, for offline completion of a manually typed code. */
export interface PantryBarcode {
    barcode: string;
    name: string;
    unit?: string | null;
    /** What one scan of this code adds when the scan names no quantity. */
    defaultQuantity: number;
    lowThreshold?: number | null;
    timesSeen: number;
    lastUsedAt: string;
}

/** Per-pantry wiring. One config row per Pantry channel; created lazily by the server. */
export interface PantryConfig {
    channelId: string;
    /** Where automatic restocks are appended; a `List` channel in this guild. `null` switches the whole loop off. */
    restockListChannelId?: string | null;
    /** How far ahead an expiry counts as "soon". Server range is 1-90; validate before sending. */
    expiryWarningDays: number;
}

/** The server's accepted range for {@link PantryConfig.expiryWarningDays}, inclusive. */
export const EXPIRY_WARNING_DAYS_MIN = 1;
export const EXPIRY_WARNING_DAYS_MAX = 90;

export function isValidExpiryWarningDays(days: number | null | undefined): boolean {
    return (
        typeof days === 'number' &&
        Number.isInteger(days) &&
        days >= EXPIRY_WARNING_DAYS_MIN &&
        days <= EXPIRY_WARNING_DAYS_MAX
    );
}

// ── Derived state ───────────────────────────────────────────────────────────

/** What a row is doing in the restock loop. "Low" and "already on the shopping list" are distinct. */
export type PantryStockState =
    /** No threshold: never chased. Not the same as "fine". */
    | 'untracked'
    /** Above its threshold. */
    | 'ok'
    /** At or below its threshold and not on the list yet. */
    | 'low'
    /** `restockedAt` set: it is on the shopping list right now. */
    | 'listed';

/** The state machine, as a pure function of the item alone. `listed` is tested first. */
export function pantryStockState(item: PantryItem): PantryStockState {
    if (item.restockedAt != null) return 'listed';
    if (item.lowThreshold == null) return 'untracked';
    return item.quantity <= item.lowThreshold ? 'low' : 'ok';
}

/** Whether the pantry's restock loop can fire at all. */
export function isRestockLoopEnabled(config: PantryConfig | null | undefined): boolean {
    return !!config && config.restockListChannelId != null && config.restockListChannelId !== '';
}

export type PantryExpiryState = 'none' | 'soon' | 'expired';

/**
 * Expiry, bucketed against the pantry's own warning window. `warningDays: null` means the server
 * already applied the window, so the only remaining question is whether the date has passed.
 */
export function pantryExpiryState(
    item: PantryItem,
    warningDays: number | null,
    now: number = Date.now(),
): PantryExpiryState {
    if (item.expiresAt == null) return 'none';
    const at = new Date(item.expiresAt).getTime();
    if (Number.isNaN(at)) return 'none';
    if (at <= now) return 'expired';
    if (warningDays == null) return 'soon';
    return at - now <= warningDays * 86_400_000 ? 'soon' : 'none';
}

// ── Realtime (server → client) ──────────────────────────────────────────────
//
// An automatic restock also emits `guild.ListItemCreated` on the list channel. That is the Lists
// module's listener; registering it here too would deliver every list item twice.

/** A new stock line. Also fired for an item created by anyone else in the house. */
export interface PantryItemCreated {
    guildId: string;
    channelId: string;
    item: PantryItem;
}

/** Any mutation of a line, including the ones the server makes on its own to `restockedAt`. */
export interface PantryItemUpdated {
    guildId: string;
    channelId: string;
    item: PantryItem;
}

/** Deletion carries the id only; the row is already gone server-side. */
export interface PantryItemDeleted {
    guildId: string;
    channelId: string;
    itemId: string;
}
