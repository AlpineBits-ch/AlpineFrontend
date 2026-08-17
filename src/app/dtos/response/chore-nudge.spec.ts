import {describe, expect, it} from 'vitest';
import {canNudge, ChoreOccurrence, nextNudgeAt, NUDGE_COOLDOWN_HOURS} from './chore.dto';

const NOW = Date.parse('2026-08-15T12:00:00Z');
const OWN = 'me';

/** Due a day ago, so a grace period of anything under 24 hours has lapsed. */
function occurrence(overrides: Partial<ChoreOccurrence> = {}): ChoreOccurrence {
    return {
        id: 'o1',
        choreId: 'c1',
        channelId: 'ch1',
        title: 'Bins',
        dueAt: '2026-08-14T12:00:00Z',
        assignedUserId: 'anna',
        effortMinutes: 10,
        isOverdue: true,
        ...overrides,
    };
}

describe('canNudge', () => {
    it("allows a nudge on somebody else's overdue turn", () => {
        expect(canNudge(occurrence(), 2, OWN, NOW)).toBe(true);
    });

    /**
     * Rendering the button on your own row is the shape a client bug takes, and the server refuses
     * it outright - so it is the first thing checked and it is never conditional.
     */
    it('refuses your own row', () => {
        expect(canNudge(occurrence({assignedUserId: OWN}), 2, OWN, NOW)).toBe(false);
    });

    it('refuses when the caller is unknown', () => {
        expect(canNudge(occurrence(), 2, null, NOW)).toBe(false);
    });

    it('refuses a completed or skipped turn', () => {
        expect(canNudge(occurrence({completedAt: '2026-08-14T18:00:00Z'}), 2, OWN, NOW)).toBe(false);
        expect(canNudge(occurrence({skippedAt: '2026-08-14T18:00:00Z'}), 2, OWN, NOW)).toBe(false);
    });

    /**
     * A nudge about something not yet overdue is not a reminder, it is a person leaning over your
     * shoulder - which is exactly what gets the feature muted, taking the real reminders with it.
     */
    it('refuses until the grace period has actually lapsed', () => {
        // Due 24 hours ago with a 48-hour grace: late by the calendar, not late by the chore.
        expect(canNudge(occurrence(), 48, OWN, NOW)).toBe(false);
        expect(canNudge(occurrence(), 23, OWN, NOW)).toBe(true);
    });

    it('refuses inside the cooldown and allows once it has lapsed', () => {
        const justNudged = new Date(NOW - 60_000).toISOString();
        expect(canNudge(occurrence({nudgedAt: justNudged}), 2, OWN, NOW)).toBe(false);

        const longAgo = new Date(NOW - (NUDGE_COOLDOWN_HOURS + 1) * 3_600_000).toISOString();
        expect(canNudge(occurrence({nudgedAt: longAgo}), 2, OWN, NOW)).toBe(true);
    });

    it('allows when the stamp is unparseable rather than locking the button forever', () => {
        expect(canNudge(occurrence({nudgedAt: 'not a date'}), 2, OWN, NOW)).toBe(true);
    });

    it('refuses when the due date is unparseable', () => {
        expect(canNudge(occurrence({dueAt: 'not a date'}), 2, OWN, NOW)).toBe(false);
    });
});

describe('nextNudgeAt', () => {
    it('is null when nobody has nudged', () => {
        expect(nextNudgeAt(occurrence())).toBeNull();
    });

    it('is the cooldown past the last nudge', () => {
        const last = '2026-08-15T00:00:00Z';
        expect(nextNudgeAt(occurrence({nudgedAt: last}))?.toISOString()).toBe(
            new Date(Date.parse(last) + NUDGE_COOLDOWN_HOURS * 3_600_000).toISOString(),
        );
    });

    it('is null for an unparseable stamp', () => {
        expect(nextNudgeAt(occurrence({nudgedAt: 'nope'}))).toBeNull();
    });
});
