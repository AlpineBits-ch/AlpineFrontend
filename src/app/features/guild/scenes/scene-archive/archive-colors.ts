/**
 * Quick picks for a shelf or a label. Chosen to stay legible against the dark surface once the chip
 * mixes them toward it; a custom colour is still one click away.
 */
export const ARCHIVE_COLORS = [
    '#e07a5f',
    '#f2cc8f',
    '#81b29a',
    '#6d9dc5',
    '#9b8bbf',
    '#c98bb9',
    '#8d99ae',
] as const;

/** What the native colour input shows when nothing is picked yet. */
export const ARCHIVE_COLOR_FALLBACK = '#6d9dc5';

/** The server's "no colour chosen" default, which is not real black. */
export const NO_COLOR = '#000000';

/** True when a stored value means "no colour", whether it is empty or the sentinel. */
export function isNoColor(value: string | null | undefined): boolean {
    return !value || value.toLowerCase() === NO_COLOR;
}
