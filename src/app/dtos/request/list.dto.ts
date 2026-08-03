/**
 * A new row. Only `text` is required; everything else is the optional detail a shopping list
 * accumulates once someone bothers to type it.
 *
 * <p>`quantity` is a string on purpose - "2 packs" and "a bunch" are what people write, and the
 * server stores it verbatim. Never send a number here after parsing one out of the input.</p>
 */
export interface CreateListItemDto {
    text: string;
    quantity?: string | null;
    note?: string | null;
    section?: string | null;
    assigneeUserId?: string | null;
}

/**
 * Only the fields sent are touched; omitting one means "leave unchanged".
 *
 * <p>Note what that rules out. The server's test is `if (dto.X is not null)`, so `null` is
 * indistinguishable from an absent key - it does **not** clear anything. For the free-text
 * fields, clearing is `''`, which the server stores verbatim and every reader treats as
 * absent. For the assignee, which is an id rather than free text, clearing is the explicit
 * {@link UpdateListItemDto.clearAssignee} flag.</p>
 */
export interface UpdateListItemDto {
    text?: string;
    /** `''` clears it - see the interface doc. `null` would silently leave the old value. */
    quantity?: string;
    /** `''` clears it. */
    note?: string;
    /** `''` clears it - and an empty section is what puts the row back in the ungrouped block. */
    section?: string;
    assigneeUserId?: string;
    /**
     * Unassigns the row. Overrides `assigneeUserId` if both are sent.
     *
     * <p>Nothing sends this yet: the List view deliberately shipped without an assignee picker,
     * so there is no way to assign a row from Alpine and therefore none to unassign one. It is
     * declared anyway because the *obvious* way to write that picker - `assigneeUserId: null` -
     * is the one thing that cannot work, and finding that out from a silent no-op is worse than
     * finding an unused field.</p>
     */
    clearAssignee?: boolean;
}

/**
 * A **partial** order, unlike most reorder endpoints here: ids omitted keep their relative order
 * *after* the ones sent, so a drag-and-drop sends the affected prefix rather than the whole list.
 */
export interface ReorderListItemsDto {
    itemIds: string[];
}
