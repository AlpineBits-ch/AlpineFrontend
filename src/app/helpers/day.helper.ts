/** How a calendar day sits relative to now. `null` is any day the UI names by its date. */
export type DayRelation = 'today' | 'yesterday' | null;

/** The bucket an unparseable timestamp lands in, so it never joins a real day. */
export const UNKNOWN_DAY_KEY = 'unknown';

/** Local, not UTC: "today" is the user's day, and `toISOString` would shift it by the offset. */
export function dayKey(date: Date): string {
    if (Number.isNaN(date.getTime())) return UNKNOWN_DAY_KEY;
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

export function dayRelationOf(key: string, now: Date = new Date()): DayRelation {
    if (key === UNKNOWN_DAY_KEY) return null;
    if (key === dayKey(now)) return 'today';
    // Going through the Date constructor rather than subtracting a day of milliseconds: a DST
    // shift makes "24 hours ago" land on the wrong calendar day twice a year.
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return key === dayKey(yesterday) ? 'yesterday' : null;
}
