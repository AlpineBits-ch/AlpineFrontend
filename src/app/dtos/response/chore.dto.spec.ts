import {describe, expect, it} from 'vitest';
import {
    balanceStanding,
    ChoreBalanceEntry,
    ChoreOccurrence,
    ChoreOccurrenceUpdated,
    choreAssignmentError,
    isChoreDone,
    isChoreOutstanding,
    isChoreSkipped,
    carriesOccurrence,
    occurrenceStatus,
    wasDoneByProxy,
} from './chore.dto';

function occurrence(overrides: Partial<ChoreOccurrence> = {}): ChoreOccurrence {
    return {
        id: 'occr_1',
        choreId: 'chor_1',
        channelId: 'chan_1',
        title: 'Washing-up',
        dueAt: '2026-08-03T18:00:00.000Z',
        assignedUserId: 'user_anna',
        effortMinutes: 15,
        completedAt: null,
        completedByUserId: null,
        skippedAt: null,
        isOverdue: false,
        ...overrides,
    };
}

function balance(overrides: Partial<ChoreBalanceEntry> = {}): ChoreBalanceEntry {
    return {userId: 'user_anna', completedMinutes: 60, completedCount: 4, balanceMinutes: 0, ...overrides};
}

describe('occurrenceStatus', () => {
    it('reports an untouched turn before its grace window as due', () => {
        expect(occurrenceStatus(occurrence())).toBe('due');
    });

    it('reports an untouched turn past its grace window as overdue', () => {
        expect(occurrenceStatus(occurrence({isOverdue: true}))).toBe('overdue');
    });

    it('reports a completed turn as done', () => {
        expect(occurrenceStatus(occurrence({
            completedAt: '2026-08-03T19:12:00.000Z',
            completedByUserId: 'user_anna',
        }))).toBe('done');
    });

    it('reports a skipped turn as skipped, never as done', () => {
        const skipped = occurrence({skippedAt: '2026-08-03T19:12:00.000Z'});
        expect(occurrenceStatus(skipped)).toBe('skipped');
        expect(isChoreDone(skipped)).toBe(false);
        expect(isChoreSkipped(skipped)).toBe(true);
    });

    it('resolves skipped ahead of done when a row somehow carries both stamps', () => {
        // Not a state the server produces, but the whole point of routing every caller through
        // this function is that no future one can draw a skip as a completion by accident.
        const both = occurrence({
            skippedAt: '2026-08-03T19:12:00.000Z',
            completedAt: '2026-08-03T19:30:00.000Z',
            completedByUserId: 'user_ben',
        });
        expect(occurrenceStatus(both)).toBe('skipped');
        expect(isChoreDone(both)).toBe(false);
    });

    it('leaves a skipped turn outstanding - it is unpaid work, which is why the rota returns', () => {
        expect(isChoreOutstanding(occurrence({skippedAt: '2026-08-03T19:12:00.000Z'}))).toBe(true);
        expect(isChoreOutstanding(occurrence())).toBe(true);
        expect(isChoreOutstanding(occurrence({isOverdue: true}))).toBe(true);
    });

    it('does not leave a completed turn outstanding', () => {
        expect(isChoreOutstanding(occurrence({completedAt: '2026-08-03T19:12:00.000Z'}))).toBe(false);
    });
});

describe('wasDoneByProxy', () => {
    it('is true when someone other than the assignee did it', () => {
        expect(wasDoneByProxy(occurrence({
            assignedUserId: 'user_anna',
            completedByUserId: 'user_ben',
            completedAt: '2026-08-03T19:12:00.000Z',
        }))).toBe(true);
    });

    it('is false when the assignee did their own turn', () => {
        expect(wasDoneByProxy(occurrence({
            assignedUserId: 'user_anna',
            completedByUserId: 'user_anna',
            completedAt: '2026-08-03T19:12:00.000Z',
        }))).toBe(false);
    });

    it('is false for a skipped turn even with a stale doer recorded', () => {
        expect(wasDoneByProxy(occurrence({
            assignedUserId: 'user_anna',
            completedByUserId: 'user_ben',
            completedAt: '2026-08-03T19:12:00.000Z',
            skippedAt: '2026-08-03T19:30:00.000Z',
        }))).toBe(false);
    });
});

describe('balanceStanding', () => {
    it('reads a negative balance as behind their share', () => {
        expect(balanceStanding(balance({balanceMinutes: -45}))).toBe('behind');
    });

    it('reads a positive balance as ahead of their share', () => {
        expect(balanceStanding(balance({balanceMinutes: 45}))).toBe('ahead');
    });

    it('reads exactly zero as even', () => {
        expect(balanceStanding(balance({balanceMinutes: 0}))).toBe('even');
    });

    it('says nothing about totals - a member can be ahead having done very little', () => {
        // balanceMinutes is relative to the house average, so this member has done 5 minutes and
        // is still ahead of a house that has done almost nothing. Rendering completedMinutes as
        // the standing would invert this row.
        const slacker = balance({completedMinutes: 5, completedCount: 1, balanceMinutes: 3});
        expect(balanceStanding(slacker)).toBe('ahead');
    });
});

describe('choreAssignmentError', () => {
    it('accepts a rotation role alone', () => {
        expect(choreAssignmentError({rotationRoleId: 'role_1', fixedAssigneeUserId: null})).toBeNull();
    });

    it('accepts a fixed assignee alone', () => {
        expect(choreAssignmentError({rotationRoleId: null, fixedAssigneeUserId: 'user_anna'})).toBeNull();
    });

    it('rejects neither - the server answers 400 and the form must ask first', () => {
        expect(choreAssignmentError({rotationRoleId: null, fixedAssigneeUserId: null})).toBe('missing');
    });

    it('rejects both', () => {
        expect(choreAssignmentError({rotationRoleId: 'role_1', fixedAssigneeUserId: 'user_anna'})).toBe('both');
    });

    it('treats empty strings as unset rather than as a value', () => {
        expect(choreAssignmentError({rotationRoleId: '', fixedAssigneeUserId: ''})).toBe('missing');
    });
});

describe('carriesOccurrence', () => {
    it('accepts the one shape the event now has - a full occurrence, from all four verbs', () => {
        const payload: ChoreOccurrenceUpdated = {
            guildId: 'gild_1',
            channelId: 'chan_1',
            occurrence: occurrence({completedAt: '2026-08-03T19:12:00.000Z'}),
        };
        expect(carriesOccurrence(payload)).toBe(true);
    });

    it('rejects the retired skip marker rather than letting a stale server throw', () => {
        // What skip used to broadcast: an id and a flag, no occurrence. A handler that assumed
        // the snapshot would dereference `undefined.id` inside the SignalR callback and take every
        // later handler for that event down with it.
        const stale = {
            guildId: 'gild_1',
            channelId: 'chan_1',
            occurrenceId: 'occr_1',
            skipped: true,
        } as unknown as ChoreOccurrenceUpdated;
        expect(carriesOccurrence(stale)).toBe(false);
    });
});
