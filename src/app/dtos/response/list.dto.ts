/** One row of a `List` channel. A List channel has no messages; these rows are its contents. */
export interface ListItem {
    id: string;
    channelId: string;
    text: string;
    /** Free text ("2", "2 packs", "a bunch"). Never parse it into a number. */
    quantity?: string | null;
    note?: string | null;
    /** Free-text grouping, e.g. "Dairy". Not an id and not an enum; whatever was typed. */
    section?: string | null;
    assigneeUserId?: string | null;
    addedByUserId: string;
    isChecked: boolean;
    checkedAt?: string | null;
    checkedByUserId?: string | null;
    position: number;
    /** Set when the pantry's restock loop added this line rather than a person. */
    sourcePantryItemId?: string | null;
    createdAt: string;
}

// ── Caps ────────────────────────────────────────────────────────────────────

/** Server-side limits, enforced here first. Both produce a bare `400` with no field information. */
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
 * @param currentCount rows already in the channel, including checked ones. The server counts the
 *        whole list, not just the visible part.
 */
export function validateNewListItem(text: string, currentCount: number): ListItemRejection | null {
    if (!text.trim()) return 'EMPTY';
    if (text.length > LIST_LIMITS.textMaxLength) return 'TEXT_TOO_LONG';
    if (currentCount >= LIST_LIMITS.maxItems) return 'LIST_FULL';
    return null;
}

// ── Ordering ────────────────────────────────────────────────────────────────

/**
 * Applies the server's reorder rule to a local list: the ids sent come first, in the order given,
 * and every id omitted keeps its relative order after them. Unknown ids are skipped, not an error.
 */
export function reorderByPartialIds<T extends {id: string}>(
    items: readonly T[],
    sentIds: readonly string[],
): T[] {
    // Insertion-ordered, so what remains after the loop is the omitted items in their original order.
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

/** Rewrites `position` to match array index, which is what "add to the end" is computed from. */
export function renumberPositions(items: readonly ListItem[]): ListItem[] {
    return items.map((item, index) => (item.position === index ? item : {...item, position: index}));
}

// ── Realtime payloads ───────────────────────────────────────────────────────
//
// Every one of the six carries `{guildId, channelId}` and then exactly one payload field.

/** Every list event names the guild and the channel; nothing here is guild-wide. */
export interface ListEventScope {
    guildId: string;
    channelId: string;
}

/**
 * The item shape on `guild.ListItemCreated`, which is not always a full `ListItemDto`: the pantry
 * restock loop emits a narrower object. {@link normalizeCreatedItem} fills the rest.
 */
export type CreatedListItem = Pick<ListItem, 'id' | 'channelId' | 'text' | 'position' | 'isChecked'> &
    Partial<ListItem>;

export interface ListItemCreated extends ListEventScope {
    item: CreatedListItem;
}

export interface ListItemUpdated extends ListEventScope {
    item: ListItem;
}

/** Emitted on a tick and an untick; `item.isChecked` says which. Never treat it as "flip it". */
export interface ListItemChecked extends ListEventScope {
    item: ListItem;
}

export interface ListItemDeleted extends ListEventScope {
    itemId: string;
}

/** Carries the ids exactly as the reordering client sent them, so it too may be partial. */
export interface ListItemsReordered extends ListEventScope {
    itemIds: string[];
}

/** "Clear done". Names how many rows went, not which; the checked ones did. */
export interface ListCleared extends ListEventScope {
    removedCount: number;
}

/** Widens a `ListItemCreated` payload into a real {@link ListItem}, keeping anything `existing` already knew. */
export function normalizeCreatedItem(item: CreatedListItem, existing?: ListItem | null): ListItem {
    return {
        ...existing,
        ...item,
        // A pantry-added row has no human author; empty string, never a made-up id.
        addedByUserId: item.addedByUserId ?? existing?.addedByUserId ?? '',
        // Never null: the row is sorted and grouped by it.
        createdAt: item.createdAt ?? existing?.createdAt ?? new Date().toISOString(),
    };
}
