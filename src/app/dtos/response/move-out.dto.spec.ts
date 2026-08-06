import {describe, expect, it} from 'vitest';
import {
    hasUnresolvedChores,
    MoveOutOutstanding,
    MoveOutSummary,
    totalOutstandingMinor,
} from './move-out.dto';

function summary(overrides: Partial<MoveOutSummary> = {}): MoveOutSummary {
    return {
        userId: 'user_ben',
        choresReassigned: 0,
        choresDropped: 0,
        choresPaused: 0,
        listItemsUnassigned: 0,
        balancesWrittenOff: [],
        ...overrides,
    };
}

describe('hasUnresolvedChores', () => {
    it('is false for a clean move-out', () => {
        expect(hasUnresolvedChores(summary({choresReassigned: 4}))).toBe(false);
    });

    it('flags chores paused because they named the leaver as fixed assignee', () => {
        // Paused, not reassigned - the house decides who picks them up, and nothing else will
        // mention them again unless the client says so here.
        expect(hasUnresolvedChores(summary({choresPaused: 2}))).toBe(true);
    });

    it('flags chores dropped because the rota had nobody left', () => {
        expect(hasUnresolvedChores(summary({choresDropped: 1}))).toBe(true);
    });

    it('does not treat reassignment as something to resolve - that one landed on its own', () => {
        expect(hasUnresolvedChores(summary({choresReassigned: 9, listItemsUnassigned: 3}))).toBe(false);
    });
});

describe('totalOutstandingMinor', () => {
    const outstanding: MoveOutOutstanding[] = [
        {channelId: 'chan_rent', currency: 'CHF', netMinor: -24000},
        {channelId: 'chan_food', currency: 'CHF', netMinor: 1500},
        {channelId: 'chan_trip', currency: 'EUR', netMinor: -5000},
    ];

    it('sums only the ledgers in the currency asked for', () => {
        // A house may run several ledgers and they need not agree on a currency, so adding the
        // minor units across them would produce a number that means nothing.
        expect(totalOutstandingMinor(outstanding, 'CHF')).toBe(-22500);
        expect(totalOutstandingMinor(outstanding, 'EUR')).toBe(-5000);
    });

    it('is zero for a currency the house does not use, rather than a mixed total', () => {
        expect(totalOutstandingMinor(outstanding, 'USD')).toBe(0);
    });

    it('is zero for a settled member', () => {
        expect(totalOutstandingMinor([], 'CHF')).toBe(0);
    });
});
