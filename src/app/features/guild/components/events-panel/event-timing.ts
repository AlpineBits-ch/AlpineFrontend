import {ScheduledEventDto} from '../../../../dtos/response/scheduled-event.dto';

export type EventPhase = 'live' | 'upcoming' | 'past';
export type DayBucket = 'today' | 'tomorrow' | 'later';

/**
 * How long an event with no declared end stays live.
 *
 * <p>An hour is a guess at a typical session: long enough that the event is still listed while
 * people are actually at it, short enough that a forgotten one does not squat at the top of the
 * panel all day. It is a constant so that is one edit to change.</p>
 */
export const OPEN_ENDED_LIVE_MS = 60 * 60 * 1000;

/** Epoch ms of the event's start, or `NaN` if `startsAt` does not parse. */
export function startTime(event: ScheduledEventDto): number {
    return new Date(event.startsAt).getTime();
}

/**
 * Epoch ms at which an event stops counting as happening.
 *
 * <p>`endsAt` when it is present and parseable. A blank or unparseable one must not be compared
 * directly - `new Date('')` is `NaN`, and `NaN` compares false in both directions, which would
 * silently drop the event out of every list at once. It falls back to
 * `startsAt + OPEN_ENDED_LIVE_MS`.</p>
 */
export function endBoundary(event: ScheduledEventDto): number {
    const end = event.endsAt ? new Date(event.endsAt).getTime() : Number.NaN;
    if (!Number.isNaN(end)) return end;

    const start = startTime(event);
    return Number.isNaN(start) ? Number.NaN : start + OPEN_ENDED_LIVE_MS;
}

/**
 * Which of the three lists an event belongs in, at a given moment.
 *
 * <p>Derived from the timestamps, never from `status`: nothing server-side moves that field off
 * `Scheduled` except an explicit cancel, and cancelled events are excluded from the list endpoint
 * entirely.</p>
 */
export function phaseOf(event: ScheduledEventDto, now: number): EventPhase {
    const start = startTime(event);
    // An unparseable start fails both comparisons below and would fall through to 'live', pinning a
    // malformed event to the top of the panel forever.
    if (Number.isNaN(start)) return 'past';

    if (now < start) return 'upcoming';
    return now > endBoundary(event) ? 'past' : 'live';
}

/** Local midnight preceding `date`. */
function startOfDay(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Which day header an upcoming event belongs under.
 *
 * <p>Compares local calendar days rather than elapsed hours: an event at 00:30 tomorrow is
 * "tomorrow" even though it is forty minutes away, which is what a reader means by the word.
 * Calendar arithmetic via `setDate` rather than adding 86 400 000 ms, so a DST boundary - where a
 * day is 23 or 25 hours long - does not misfile the next day as "later".</p>
 */
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
