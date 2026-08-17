import {QuietHoursDto} from '../../dtos/response/quiet-hours.dto';

export const MINUTES_PER_DAY = 1440;

/** Computed via `Intl` against the IANA id, never a cached offset: an offset would drift an hour twice a year, exactly when DST changes. */
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

/** Wraps midnight when `start > end` (22:00 → 07:00 is normal; end exclusive); `start === end` means no window, not a 24-hour one - the other guess would defer every reminder forever. */
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
    return startMinute < endMinute ? endMinute - startMinute : MINUTES_PER_DAY - startMinute + endMinute;
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

/** Not a list check: the zone set is the platform's, so this relies on `Intl` throwing on an unknown zone rather than a hard-coded allowlist. */
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
    'START_OUT_OF_RANGE' | 'END_OUT_OF_RANGE' | 'SAME_START_AND_END' | 'UNKNOWN_TIME_ZONE';

/** The three things the server 400s for, checked before the round trip; order only affects which error is shown first, the checks are independent. */
export function validateQuietHours(config: QuietHoursDto): QuietHoursError | null {
    if (!isValidMinuteOfDay(config.startMinuteLocal)) return 'START_OUT_OF_RANGE';
    if (!isValidMinuteOfDay(config.endMinuteLocal)) return 'END_OUT_OF_RANGE';
    if (config.startMinuteLocal === config.endMinuteLocal) return 'SAME_START_AND_END';
    if (!isValidTimeZoneId(config.timeZoneId)) return 'UNKNOWN_TIME_ZONE';
    return null;
}
