import {ScheduledEventDto, ScheduledEventStatus} from '../../../../dtos/response/scheduled-event.dto';
import {dayBucket, endBoundary, OPEN_ENDED_LIVE_MS, phaseOf, startTime} from './event-timing';

// Built from local-time components, not a UTC string: `dayBucket` compares local calendar days, so a UTC-pinned fixture would bucket differently depending on the machine's timezone.
const NOW = new Date(2026, 7, 1, 12, 0, 0).getTime();
const MINUTE = 60 * 1000;

function event(overrides: Partial<ScheduledEventDto> = {}): ScheduledEventDto {
    return {
        id: 'e1',
        guildId: 'g1',
        creatorUserId: 'u1',
        title: 'Event',
        description: null,
        startsAt: new Date(NOW + 60 * MINUTE).toISOString(),
        endsAt: null,
        location: null,
        voiceChannelId: null,
        status: ScheduledEventStatus.Scheduled,
        interestedCount: 0,
        isInterested: false,
        ...overrides,
    };
}

describe('phaseOf', () => {
    it('calls an event that has not started upcoming', () => {
        expect(phaseOf(event({startsAt: new Date(NOW + MINUTE).toISOString()}), NOW)).toBe('upcoming');
    });

    it('calls an event live from the moment it starts', () => {
        const e = event({
            startsAt: new Date(NOW).toISOString(),
            endsAt: new Date(NOW + 30 * MINUTE).toISOString(),
        });

        expect(phaseOf(e, NOW)).toBe('live');
    });

    it('calls an event live right up to its end', () => {
        const e = event({
            startsAt: new Date(NOW - 30 * MINUTE).toISOString(),
            endsAt: new Date(NOW + MINUTE).toISOString(),
        });

        expect(phaseOf(e, NOW)).toBe('live');
        expect(phaseOf(e, NOW + 2 * MINUTE)).toBe('past');
    });

    it('keeps an event with no end time live for the grace window, then drops it', () => {
        const e = event({startsAt: new Date(NOW).toISOString(), endsAt: null});

        expect(phaseOf(e, NOW)).toBe('live');
        expect(phaseOf(e, NOW + OPEN_ENDED_LIVE_MS - MINUTE)).toBe('live');
        expect(phaseOf(e, NOW + OPEN_ENDED_LIVE_MS + MINUTE)).toBe('past');
    });

    it('treats a blank endsAt exactly like an absent one', () => {
        // `new Date('')` is NaN and NaN compares false both ways, so an unguarded comparison drops the event out of every list at once.
        const e = event({startsAt: new Date(NOW).toISOString(), endsAt: ''});

        expect(phaseOf(e, NOW)).toBe('live');
        expect(phaseOf(e, NOW + OPEN_ENDED_LIVE_MS + MINUTE)).toBe('past');
    });

    it('treats an unparseable endsAt like an absent one', () => {
        const e = event({startsAt: new Date(NOW).toISOString(), endsAt: 'not-a-date'});

        expect(phaseOf(e, NOW)).toBe('live');
    });

    it('files an event with an unparseable start under past rather than pinning it live', () => {
        expect(phaseOf(event({startsAt: 'not-a-date'}), NOW)).toBe('past');
    });
});

describe('endBoundary', () => {
    it('uses endsAt when it parses', () => {
        const endsAt = new Date(NOW + 90 * MINUTE);

        expect(endBoundary(event({endsAt: endsAt.toISOString()}))).toBe(endsAt.getTime());
    });

    it('adds the grace window to startsAt when endsAt is absent', () => {
        const startsAt = new Date(NOW + 10 * MINUTE);
        const e = event({startsAt: startsAt.toISOString(), endsAt: null});

        expect(endBoundary(e)).toBe(startsAt.getTime() + OPEN_ENDED_LIVE_MS);
    });

    it('is NaN when the start itself is unparseable', () => {
        expect(Number.isNaN(endBoundary(event({startsAt: 'nope', endsAt: null})))).toBe(true);
    });
});

describe('startTime', () => {
    it('returns the parsed start', () => {
        expect(startTime(event({startsAt: new Date(NOW).toISOString()}))).toBe(NOW);
    });
});

describe('dayBucket', () => {
    it('buckets a later hour of the same calendar day as today', () => {
        expect(dayBucket(new Date(2026, 7, 1, 23, 30).toISOString(), NOW)).toBe('today');
    });

    it('buckets an earlier hour of the same calendar day as today', () => {
        expect(dayBucket(new Date(2026, 7, 1, 1, 0).toISOString(), NOW)).toBe('today');
    });

    it('buckets just after midnight as tomorrow, not today', () => {
        // 40 minutes away by the clock, but a different calendar day, which is what a reader means by "tomorrow".
        const nearMidnight = new Date(2026, 7, 1, 23, 20).getTime();

        expect(dayBucket(new Date(2026, 7, 2, 0, 0).toISOString(), nearMidnight)).toBe('tomorrow');
    });

    it('buckets two days out as later', () => {
        expect(dayBucket(new Date(2026, 7, 3, 9, 0).toISOString(), NOW)).toBe('later');
    });

    it('buckets an unparseable start as later rather than throwing', () => {
        expect(dayBucket('not-a-date', NOW)).toBe('later');
    });
});
