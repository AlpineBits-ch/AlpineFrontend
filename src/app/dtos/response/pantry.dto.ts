/**
 * Pantry: the stock held in one location - a fridge, a freezer, a cellar. One Pantry
 * channel is one location, which is why every threshold and the restock wiring below
 * are per channel rather than per house.
 *
 * The module's whole point is the **restock loop**: when an item's quantity drops to or
 * below its threshold the server appends it to a configured shopping list and stamps
 * `restockedAt`. Nothing in this client performs that append - we render its
 * consequences, and every rule about when it fires lives on the server.
 */

/**
 * One line of stock.
 *
 * <p>Field names are taken from the wire schema (`guild.PantryItemCreated`.`item`,
 * `Guild.Application.Dtos.Response.PantryItemDto`), which matches the published guide
 * exactly - there is nothing to reconcile here.</p>
 */
export interface PantryItem {
    id: string;
    /** The Pantry channel. An item never moves between pantries; edit means delete + add. */
    channelId: string;
    name: string;
    /**
     * A **decimal**, unlike the List module's free-text `quantity`. It has to be a number
     * because the server compares it against {@link lowThreshold} - "half a bag" cannot be
     * put in order against 2, so it is not offered. Never widen this to `string`.
     */
    quantity: number;
    /** Free text ("kg", "bottles"). Purely a label; nothing is converted or compared by it. */
    unit?: string | null;
    /**
     * The restock trigger for this one item, or `null` for **restock tracking off**.
     *
     * <p>`null` and `0` are different and must stay different everywhere: `0` is a real
     * threshold that fires when the last one is used up, `null` means the item is never
     * chased. Every read of this field has to be a `=== null` / `!= null` test, never a
     * falsy one - `if (item.lowThreshold)` silently turns a 0 threshold into "off".</p>
     */
    lowThreshold?: number | null;
    /** ISO-8601. `null` for anything that doesn't go off. */
    expiresAt?: string | null;
    /**
     * The server's own answer to "is this at or under its threshold". Reported even when
     * the restock loop is off, because being low is a fact about the stock, not about the
     * wiring. See {@link pantryStockState} for why the client recomputes it anyway.
     */
    isLow: boolean;
    /**
     * Set while this item is **sitting on the shopping list**, cleared when it isn't.
     *
     * <p>It is the server's idempotency guard - an item already stamped is not appended a
     * second time - and it is released when the quantity climbs back above the threshold
     * **or** the list line is deleted / cleared as bought. So an item cycles through this
     * field repeatedly over its life. Anything derived from it must be recomputed from the
     * latest payload rather than latched on first sight.</p>
     */
    restockedAt?: string | null;
    addedByUserId: string;
}

/** Per-pantry wiring. One config row per Pantry channel; created lazily by the server. */
export interface PantryConfig {
    channelId: string;
    /**
     * Where automatic restocks are appended. Must be a `List` channel **in this guild**.
     *
     * <p>`null` switches the **entire loop off** for this pantry, whatever the individual
     * items' thresholds say. That is the one piece of state the config UI must not bury:
     * per-item thresholds with no list channel are inert, and a threshold that silently
     * does nothing is worse than no threshold at all.</p>
     */
    restockListChannelId?: string | null;
    /** How far ahead an expiry counts as "soon". Server range is 1-90; validate before sending. */
    expiryWarningDays: number;
}

/** The server's accepted range for {@link PantryConfig.expiryWarningDays}, inclusive. */
export const EXPIRY_WARNING_DAYS_MIN = 1;
export const EXPIRY_WARNING_DAYS_MAX = 90;

export function isValidExpiryWarningDays(days: number | null | undefined): boolean {
    return typeof days === 'number'
        && Number.isInteger(days)
        && days >= EXPIRY_WARNING_DAYS_MIN
        && days <= EXPIRY_WARNING_DAYS_MAX;
}

// ── Derived state ───────────────────────────────────────────────────────────

/**
 * What a row is doing in the restock loop. Four states, because "low" and "already on the
 * shopping list" are the two people confuse and the whole module is judged on telling them
 * apart: one is a chore waiting to happen, the other is a chore already handed off.
 */
export type PantryStockState =
/** No threshold - this item is simply never chased. Not the same as "fine". */
    | 'untracked'
    /** Above its threshold. */
    | 'ok'
    /** At or below its threshold and **not** on the list yet. */
    | 'low'
    /** `restockedAt` set: it is on the shopping list right now. */
    | 'listed';

/**
 * The state machine, as a pure function of the item alone - which is what stops it
 * latching. `listed` is not a flag we raise and clear; it is `restockedAt != null` read
 * fresh off whatever payload arrived last, so an update that releases the stamp drops the
 * row straight back to `low` or `ok` with nothing to reset.
 *
 * `listed` is tested first deliberately. A line sitting on the shopping list is a fact
 * about the house regardless of what the threshold now says, and the alternative ordering
 * hides a listed item the moment someone edits its threshold to null.
 *
 * The low test is recomputed here rather than read from {@link PantryItem.isLow}. They
 * agree - but writing the comparison out is what makes `lowThreshold: 0` provably a real
 * threshold rather than something a `??` or a falsy guard quietly turns into "off".
 */
export function pantryStockState(item: PantryItem): PantryStockState {
    if (item.restockedAt != null) return 'listed';
    if (item.lowThreshold == null) return 'untracked';
    return item.quantity <= item.lowThreshold ? 'low' : 'ok';
}

/**
 * Whether the pantry's restock loop can fire at all. A `low` row in a pantry with no list
 * channel will never be appended to anything, so the UI has to say so rather than let the
 * threshold imply an action nobody configured.
 */
export function isRestockLoopEnabled(config: PantryConfig | null | undefined): boolean {
    return !!config && config.restockListChannelId != null && config.restockListChannelId !== '';
}

export type PantryExpiryState = 'none' | 'soon' | 'expired';

/**
 * Expiry, bucketed against the pantry's own warning window. `expiresAt` is a date-time,
 * but people think in days, so an item expiring later today is `soon`, not `expired`,
 * until the instant actually passes.
 *
 * <p>`warningDays: null` means <b>the server already applied the window</b> - which is what
 * `GET /pantry/expiring` does when `days` is omitted, giving every pantry its own
 * `expiryWarningDays`. Anything still in that answer is by definition inside its own pantry's
 * window, so the only question left is whether the date has passed. Re-bucketing those rows
 * against a number picked here would hide exactly the ones a long-window freezer reported.</p>
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
// All three carry the guild **and** the channel: the guild id is what the guild-scoped
// expiring view keys on, the channel id is what the per-pantry list keys on, and neither
// can be derived from the other without the channel already being cached.
//
// A fourth event is *not* listed here on purpose. An automatic restock also emits
// `guild.ListItemCreated` on the **list** channel; that is the Lists module's listener and
// registering it here would deliver every list item twice - `RealtimeConnectionService.on`
// does not deduplicate.

/** A new stock line. Also fired for an item created by anyone else in the house. */
export interface PantryItemCreated {
    guildId: string;
    channelId: string;
    item: PantryItem;
}

/**
 * Any mutation of a line - including the ones the *server* makes on its own: stamping
 * `restockedAt` when the loop fires, and releasing it when the item is restocked or the
 * list line is cleared. So this is the event the restock badge lives and dies by.
 */
export interface PantryItemUpdated {
    guildId: string;
    channelId: string;
    item: PantryItem;
}

/** Deletion carries the id only - the row is already gone server-side. */
export interface PantryItemDeleted {
    guildId: string;
    channelId: string;
    itemId: string;
}
