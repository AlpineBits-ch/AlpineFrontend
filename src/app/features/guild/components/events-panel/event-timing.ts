import {ScheduledEventDto} from '../../../../dtos/response/scheduled-event.dto';

export type EventPhase = 'live' | 'upcoming' | 'past';
export type DayBucket = 'today' | 'tomorrow' | 'later';

/** How long an event with no declared end stays live: long enough that it's still listed while people are at it, short enough that a forgotten one doesn't squat at the top all day. */
export const OPEN_ENDED_LIVE_MS = 60 * 60 * 1000;

/** Epoch ms of the event's start, or `NaN` if `startsAt` does not parse. */
export function startTime(event: ScheduledEventDto): number {
    return new Date(event.startsAt).getTime();
}

/** Epoch ms at which an event stops counting as happening. `endsAt` when parseable; a blank/unparseable one must not be compared directly, since `NaN` compares false in both directions and would silently drop the event from every list. Falls back to `startsAt + OPEN_ENDED_LIVE_MS`. */
export function endBoundary(event: ScheduledEventDto): number {
    const end = event.endsAt ? new Date(event.endsAt).getTime() : Number.NaN;
    if (!Number.isNaN(end)) return end;

    const start = startTime(event);
    return Number.isNaN(start) ? Number.NaN : start + OPEN_ENDED_LIVE_MS;
}

/** Which of the three lists an event belongs in, at a given moment. Derived from timestamps, never from `status`: nothing server-side moves that field off `Scheduled` except an explicit cancel, and cancelled events are excluded from the list endpoint entirely. */
export function phaseOf(event: ScheduledEventDto, now: number): EventPhase {
    const start = startTime(event);
    // An unparseable start fails both comparisons below and would fall through to 'live', pinning a malformed event to the top of the panel forever.
    if (Number.isNaN(start)) return 'past';

    if (now < start) return 'upcoming';
    return now > endBoundary(event) ? 'past' : 'live';
}

/** Local midnight preceding `date`. */
function startOfDay(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Which day header an upcoming event belongs under. Compares local calendar days, not elapsed hours: an event at 00:30 tomorrow is "tomorrow" even forty minutes away. Uses `setDate` rather than adding 86400000ms, so a DST boundary (a 23 or 25 hour day) doesn't misfile the next day as "later". */
export function dayBucket(startsAt: string, now: number): DayBucket {
    const start = new Date(startsAt);
    if (Number.isNaN(start.getTime())) return 'later';

    const today = startOfDay(new Date(now));
    const day = startOfDay(start);
    if (day <= today) return 'today';

    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return day === startOfDay(tomorrow) ? 'tomorrow' : 'later';
}
