import {QuietHoursDto} from '../../dtos/response/quiet-hours.dto';

export const MINUTES_PER_DAY = 1440;

/**
 * Where in its local day a guild currently is, or `null` for a time zone this runtime rejects.
 *
 * <p>Computed through `Intl` rather than from an offset: the household's window is stored against
 * an IANA id precisely so it survives DST, and an offset cached at save time would drift by an
 * hour twice a year in exactly the season people notice.</p>
 */
export function minuteOfDayIn(timeZoneId: string, at: Date = new Date()): number | null {
    if (!timeZoneId) return null;
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: timeZoneId,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(at);
        const hour = Number(parts.find(p => p.type === 'hour')?.value);
        const minute = Number(parts.find(p => p.type === 'minute')?.value);
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
        return (hour % 24) * 60 + minute;
    } catch {
        return null;
    }
}

/**
 * Whether a minute-of-day falls inside the window.
 *
 * <p><b>The window wraps midnight whenever `start > end`, and 22:00 → 07:00 is the normal case.</b>
 * A naive `m >= start && m < end` reports "never quiet" for every household that actually uses
 * this. The end is exclusive so that a window ending at 07:00 is over at 07:00.</p>
 *
 * <p>`start === end` is rejected by the server, so it is treated here as no window rather than as
 * a 24-hour one - guessing the other way would silently defer every reminder forever.</p>
 */
export function isMinuteWithinWindow(startMinute: number, endMinute: number, minute: number): boolean {
    if (startMinute === endMinute) return false;
    return startMinute < endMinute
        ? minute >= startMinute && minute < endMinute
        : minute >= startMinute || minute < endMinute;
}

/** Whether the guild is in its quiet hours right now. Disabled always answers `false`. */
export function isWithinQuietHours(config: QuietHoursDto | null | undefined, at: Date = new Date()): boolean {
    if (!config?.enabled) return false;
    const minute = minuteOfDayIn(config.timeZoneId, at);
    if (minute === null) return false;
    return isMinuteWithinWindow(config.startMinuteLocal, config.endMinuteLocal, minute);
}

/** How long the window lasts, in minutes. Wrapped windows are measured the long way round. */
export function windowLengthMinutes(startMinute: number, endMinute: number): number {
    if (startMinute === endMinute) return 0;
    return startMinute < endMinute
        ? endMinute - startMinute
        : MINUTES_PER_DAY - startMinute + endMinute;
}

/** `1320` -> `"22:00"`, the value an `<input type="time">` wants. */
export function formatMinuteOfDay(minute: number): string {
    const m = ((Math.round(minute) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** `"22:00"` -> `1320`. `null` for anything that is not a time of day. */
export function parseMinuteOfDay(value: string | null | undefined): number | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
}

export function isValidMinuteOfDay(minute: unknown): minute is number {
    return typeof minute === 'number' && Number.isInteger(minute) && minute >= 0 && minute < MINUTES_PER_DAY;
}

/**
 * Whether this runtime knows the IANA id.
 *
 * <p>Not a list check: the set of zones is the platform's, and hard-coding one here would reject
 * ids the server accepts. `Intl` throws on an unknown zone, which is the only honest test.</p>
 */
export function isValidTimeZoneId(id: string | null | undefined): boolean {
    if (!id || !id.trim()) return false;
    try {
        new Intl.DateTimeFormat('en-GB', {timeZone: id});
        return true;
    } catch {
        return false;
    }
}

/** The browser's zone, so nobody has to hunt for their own city in a list. */
export function browserTimeZoneId(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export type QuietHoursError =
    | 'START_OUT_OF_RANGE'
    | 'END_OUT_OF_RANGE'
    | 'SAME_START_AND_END'
    | 'UNKNOWN_TIME_ZONE';

/**
 * The three things the server returns `400` for, checked before the round trip.
 *
 * <p>Order matters only in that the first error is the one shown; all three are independent.</p>
 */
export function validateQuietHours(config: QuietHoursDto): QuietHoursError | null {
    if (!isValidMinuteOfDay(config.startMinuteLocal)) return 'START_OUT_OF_RANGE';
    if (!isValidMinuteOfDay(config.endMinuteLocal)) return 'END_OUT_OF_RANGE';
    if (config.startMinuteLocal === config.endMinuteLocal) return 'SAME_START_AND_END';
    if (!isValidTimeZoneId(config.timeZoneId)) return 'UNKNOWN_TIME_ZONE';
    return null;
}
