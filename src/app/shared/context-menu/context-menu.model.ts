export interface MenuItemCommandEvent {
    originalEvent?: Event;
    item: MenuItem;
}

export interface MenuItem {
    id?: string;
    label?: string;
    /** Icon class, e.g. `pi pi-trash`. */
    icon?: string;
    styleClass?: string;
    disabled?: boolean;
    /** Defaults to true. */
    visible?: boolean;
    separator?: boolean;
    /** Section label drawn above the following rows. */
    header?: string;
    /** Right-aligned hint. The menu renders it, it does not bind the shortcut. */
    key?: string;
    danger?: boolean;
    /** Draws the submenu arrow on a row that opens something the menu does not own. */
    chevron?: boolean;
    /** Fires when the pointer enters the row, for a row that reveals a panel on hover. */
    hover?: (event: MenuItemCommandEvent) => void;
    /** Name of a consumer `appMenuSlot` template rendered in place of this row. */
    slot?: string;
    /** Reaches the slot template as `item.data` and the command event. */
    data?: unknown;
    items?: MenuItem[];
    command?: (event: MenuItemCommandEvent) => void;
}

export function isSelectable(item: MenuItem): boolean {
    return !item.separator && !item.header && !item.disabled;
}

/** Drops hidden rows, then any separator that ended up leading, trailing or doubled. */
export function normalizeItems(items: readonly MenuItem[]): MenuItem[] {
    const visible = items.filter(item => item.visible !== false);
    const out: MenuItem[] = [];
    for (const item of visible) {
        if (item.separator && (out.length === 0 || out[out.length - 1].separator)) continue;
        out.push(item);
    }
    while (out.length > 0 && out[out.length - 1].separator) out.pop();
    return out;
}
