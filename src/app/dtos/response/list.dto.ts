/**
 * One row of a `List` channel - a line on the shopping list or the todo list.
 *
 * <p>A List channel has no messages: these rows *are* its contents. Field names are transcribed
 * from `Guild.Application.Dtos.Response.ListItemDto` as it appears in the realtime contract, which
 * is the same shape the REST routes return.</p>
 */
export interface ListItem {
    id: string;
    channelId: string;
    text: string;
    /**
     * Free text, deliberately - "2", "2 packs", "a bunch". Nothing computes on it, so nothing here
     * parses it into a number either; doing so would turn "a bunch" into `NaN` and lose what the
     * person actually wrote.
     */
    quantity?: string | null;
    note?: string | null;
    /** Free-text grouping, e.g. "Dairy". Not an id, not an enum - whatever was typed. */
    section?: string | null;
    assigneeUserId?: string | null;
    addedByUserId: string;
    isChecked: boolean;
    checkedAt?: string | null;
    checkedByUserId?: string | null;
    position: number;
    /**
     * Set when the pantry's restock loop added this line rather than a person. Rendered as a badge
     * so nobody wonders who put oat milk on the list; the Pantry module owns everything else about
     * it, including the item it points at.
     */
    sourcePantryItemId?: string | null;
    createdAt: string;
}

// ── Caps ────────────────────────────────────────────────────────────────────

/**
 * Server-side limits, enforced here first.
 *
 * <p>Both produce a bare `400` with no field information, so letting one through means the user
 * gets "Bad Request" for having typed a long line. Checked before the request instead.</p>
 */
export const LIST_LIMITS = {
    /** Characters per `text`. */
    textMaxLength: 200,
    /** Rows per list channel. */
    maxItems: 500,
} as const;

/** Why a would-be item was refused locally. `null` from {@link validateNewListItem} means fine. */
export type ListItemRejection = 'EMPTY' | 'TEXT_TOO_LONG' | 'LIST_FULL';

/**
 * The two caps plus "not blank", in the order the user would hit them.
 *
 * @param currentCount rows already in the channel, including checked ones - the server counts the
 *        whole list, not just the visible part, so a client filtered to unchecked must not.
 */
export function validateNewListItem(text: string, currentCount: number): ListItemRejection | null {
    if (!text.trim()) return 'EMPTY';
    if (text.length > LIST_LIMITS.textMaxLength) return 'TEXT_TOO_LONG';
    if (currentCount >= LIST_LIMITS.maxItems) return 'LIST_FULL';
    return null;
}

// ── Ordering ────────────────────────────────────────────────────────────────

/**
 * Applies the server's reorder rule to a local list: **the ids sent come first, in the order
 * given; every id omitted keeps its relative order after them.**
 *
 * <p>That rule is why a drag-and-drop only has to send the moved neighbourhood, and it is also why
 * the neighbourhood has to be a *prefix* - see `ListService.moveItem`. Ids that aren't held are
 * skipped rather than treated as an error: a reorder echo can name a row this client has not
 * fetched (a concurrent create), and dropping it silently is better than desynchronizing the
 * whole list over it.</p>
 */
export function reorderByPartialIds<T extends { id: string }>(
    items: readonly T[],
    sentIds: readonly string[],
): T[] {
    // Insertion-ordered, and deleting from it does not disturb the rest - so what remains after
    // the loop is exactly the omitted items in their original relative order.
    const remaining = new Map(items.map(item => [item.id, item]));
    const moved: T[] = [];

    for (const id of sentIds) {
        const item = remaining.get(id);
        if (!item) continue;
        remaining.delete(id);
        moved.push(item);
    }

    return [...moved, ...remaining.values()];
}

/**
 * Rewrites `position` to match array index.
 *
 * <p>Array order is what the view renders, but `position` is what "add to the end" is computed
 * from - after a reorder the server's numbers describe an order that no longer exists locally, so
 * leaving them alone puts the next new row in the middle of the list.</p>
 */
export function renumberPositions(items: readonly ListItem[]): ListItem[] {
    return items.map((item, index) => item.position === index ? item : {...item, position: index});
}

// ── Realtime payloads ───────────────────────────────────────────────────────
//
// Transcribed from asyncapi.json (`components.messages.guild_ListItem*`), not from prose. Every
// one of the six carries `{guildId, channelId}` and then exactly one payload field.

/** Every list event names the guild and the channel; nothing here is guild-wide. */
export interface ListEventScope {
    guildId: string;
    channelId: string;
}

/**
 * The item shape on `guild.ListItemCreated`, which is **not always a full `ListItemDto`**.
 *
 * <p>Two call sites emit under that name. `ListEndpoint` sends the complete row; the pantry's
 * restock loop (`PantryRestockService`) sends an anonymous object carrying only
 * `id, channelId, text, quantity, section, position, sourcePantryItemId, isChecked` - no
 * `addedByUserId`, no `createdAt`, no `note` or `assigneeUserId`. A handler that assumed the full
 * DTO would render an auto-added row with `undefined` as its author and sort it by `undefined`
 * as its timestamp, so the narrow shape is the type and {@link normalizeCreatedItem} fills the
 * rest.</p>
 */
export type CreatedListItem =
    Pick<ListItem, 'id' | 'channelId' | 'text' | 'position' | 'isChecked'>
    & Partial<ListItem>;

export interface ListItemCreated extends ListEventScope {
    item: CreatedListItem;
}

export interface ListItemUpdated extends ListEventScope {
    item: ListItem;
}

/**
 * Emitted on a tick *and* an untick - `item.isChecked` says which. Notably **not** emitted when
 * the call was a no-op (see §3: ticking an already-ticked item returns `200` and broadcasts
 * nothing), which is why nothing may treat this event as "flip it".
 */
export interface ListItemChecked extends ListEventScope {
    item: ListItem;
}

export interface ListItemDeleted extends ListEventScope {
    itemId: string;
}

/** Carries the ids exactly as the reordering client sent them - so it, too, may be partial. */
export interface ListItemsReordered extends ListEventScope {
    itemIds: string[];
}

/** "Clear done". Names how many rows went, not which - the checked ones did. */
export interface ListCleared extends ListEventScope {
    removedCount: number;
}

/**
 * Widens a `ListItemCreated` payload into a real {@link ListItem}.
 *
 * <p>The pantry variant omits half the fields (see {@link CreatedListItem}); `existing` is the row
 * already held under that id, if any, so a create echoing a row this client optimistically added
 * keeps the author and timestamp it already knew rather than blanking them.</p>
 */
export function normalizeCreatedItem(item: CreatedListItem, existing?: ListItem | null): ListItem {
    return {
        ...existing,
        ...item,
        // A pantry-added row genuinely has no human author. Empty string rather than a made-up id:
        // it is compared against the viewer's own id to decide "may I edit this", and must lose.
        addedByUserId: item.addedByUserId ?? existing?.addedByUserId ?? '',
        // Never null - the row is sorted and grouped by it. The event carries no timestamp on the
        // pantry path, and "now" is within milliseconds of true for an event we just received.
        createdAt: item.createdAt ?? existing?.createdAt ?? new Date().toISOString(),
    };
}
