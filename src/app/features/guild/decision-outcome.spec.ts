import {
    blocksForOption,
    canOptionCarry,
    decisionResultKey,
    decisionsInDisplayOrder,
    decisionStatusTone,
    isAwaitingResolution,
    isDecisionOpen,
    isDecisionResolved,
    optionsInDisplayOrder,
    optionStanding,
    quorumProgress,
    wholeDecisionBlocks,
} from './decision-outcome';
import {
    Decision,
    DecisionBlock,
    DecisionOption,
    DecisionStatus,
    DecisionVoteKind,
    normalizeDecision,
} from '../../dtos/response/decision.dto';

function option(overrides: Partial<DecisionOption> = {}): DecisionOption {
    return {id: 'o1', title: 'Option', position: 0, supportCount: 0, isBlocked: false, ...overrides};
}

function decision(overrides: Partial<Decision> = {}): Decision {
    return {
        id: 'd1',
        channelId: 'c1',
        title: 'Get a dishwasher?',
        createdByUserId: 'u1',
        status: DecisionStatus.Open,
        options: [],
        blocks: [],
        ...overrides,
    };
}

describe('blocks beat support', () => {
    it('an option with three support and one block cannot carry', () => {
        const blocked = option({id: 'a', supportCount: 3, isBlocked: true});
        expect(canOptionCarry(blocked)).toBe(false);
    });

    it('reports a blocked option as blocked however much support it has', () => {
        const a = option({id: 'a', title: 'Buy one', supportCount: 3, isBlocked: true});
        const b = option({id: 'b', title: 'Wait', position: 1, supportCount: 1});
        const d = decision({options: [a, b]});

        expect(optionStanding(d, a)).toBe('blocked');
        expect(optionStanding(d, b)).toBe('eligible');
    });

    it('only the server-named outcome is carried, not the most-supported option', () => {
        const a = option({id: 'a', supportCount: 9});
        const b = option({id: 'b', position: 1, supportCount: 1});
        const d = decision({status: DecisionStatus.Decided, outcomeOptionId: 'b', options: [a, b]});

        expect(optionStanding(d, b)).toBe('carried');
        expect(optionStanding(d, a)).toBe('eligible');
    });
});

describe('option ordering', () => {
    it('sorts by position, never by supportCount', () => {
        const d = decision({
            options: [
                option({id: 'c', title: 'Third', position: 2, supportCount: 99}),
                option({id: 'a', title: 'First', position: 0, supportCount: 0}),
                option({id: 'b', title: 'Second', position: 1, supportCount: 5}),
            ],
        });

        expect(optionsInDisplayOrder(d).map(o => o.id)).toEqual(['a', 'b', 'c']);
    });

    it('falls back to title when positions collide, so the order is at least stable', () => {
        const d = decision({
            options: [
                option({id: 'b', title: 'Beta', position: 0}),
                option({id: 'a', title: 'Alpha', position: 0}),
            ],
        });

        expect(optionsInDisplayOrder(d).map(o => o.id)).toEqual(['a', 'b']);
    });

    it('does not mutate the decision it was handed', () => {
        const d = decision({
            options: [option({id: 'b', position: 1}), option({id: 'a', position: 0})],
        });
        optionsInDisplayOrder(d);
        expect(d.options.map(o => o.id)).toEqual(['b', 'a']);
    });
});

describe('objections', () => {
    const perOption: DecisionBlock = {userId: 'u2', optionId: 'a', reason: 'No room for it'};
    const wholeNull: DecisionBlock = {userId: 'u3', optionId: null, reason: 'Not our call to make'};
    const wholeMissing = {userId: 'u4', reason: 'Landlord decides'} as DecisionBlock;

    const d = decision({
        options: [option({id: 'a', isBlocked: true})],
        blocks: [perOption, wholeNull, wholeMissing],
    });

    it('scopes per-option objections to their option', () => {
        expect(blocksForOption(d, 'a')).toEqual([perOption]);
        expect(blocksForOption(d, 'b')).toEqual([]);
    });

    it('treats a null *and* an absent optionId as objecting to the whole decision', () => {
        expect(wholeDecisionBlocks(d)).toEqual([wholeNull, wholeMissing]);
    });

    it('never files a whole-decision objection under an option', () => {
        expect(blocksForOption(d, 'a')).not.toContain(wholeNull);
    });
});

describe('quorum', () => {
    it('counts supports and blocks, and nothing else - abstentions do not count', () => {
        // Two supports and one block is three non-abstain votes. Any number of members who
        // abstained is invisible here on purpose: an abstention never moves quorum.
        const d = decision({
            quorum: 3,
            options: [option({id: 'a', supportCount: 2})],
            blocks: [{userId: 'u9', optionId: 'a', reason: 'Too expensive'}],
        });

        expect(quorumProgress(d)).toEqual({cast: 3, required: 3, met: true});
    });

    it('is short when only abstentions were cast', () => {
        const d = decision({quorum: 2, options: [option({id: 'a', supportCount: 0})]});
        expect(quorumProgress(d)).toEqual({cast: 0, required: 2, met: false});
    });

    it('has no threshold when quorum is null', () => {
        const d = decision({quorum: null, options: [option({supportCount: 1})]});
        expect(quorumProgress(d)).toEqual({cast: 1, required: null, met: true});
    });
});

describe('statuses', () => {
    it('Blocked reads as "we could not agree", not as a runner-up', () => {
        const d = decision({
            status: DecisionStatus.Blocked,
            outcomeOptionId: null,
            options: [
                option({id: 'a', supportCount: 4, isBlocked: true}),
                option({id: 'b', position: 1, supportCount: 1, isBlocked: true}),
            ],
        });

        expect(decisionResultKey(d)).toBe('DECISIONS.RESULT.BLOCKED');
        expect(decisionStatusTone(d.status)).toBe('bad');
        // Nothing carried, even though one option is clearly ahead on support.
        expect(d.options.every(o => optionStanding(d, o) === 'blocked')).toBe(true);
    });

    it('Expired means quorum was never reached', () => {
        expect(decisionResultKey(decision({status: DecisionStatus.Expired}))).toBe(
            'DECISIONS.RESULT.EXPIRED',
        );
    });

    it('only Open takes votes', () => {
        expect(isDecisionOpen(decision({status: DecisionStatus.Open}))).toBe(true);
        for (const status of [
            DecisionStatus.Decided,
            DecisionStatus.Blocked,
            DecisionStatus.Cancelled,
            DecisionStatus.Expired,
        ]) {
            expect(isDecisionResolved(decision({status}))).toBe(true);
        }
    });
});

describe('closesAt', () => {
    const past = '2026-01-01T00:00:00Z';
    const future = '2099-01-01T00:00:00Z';
    const now = new Date('2026-06-01T00:00:00Z').getTime();

    it('a passed deadline is "awaiting resolution", not a status change', () => {
        const d = decision({closesAt: past});
        expect(isAwaitingResolution(d, now)).toBe(true);
        // The countdown reaching zero must not flip anything - the server resolves within five
        // minutes and the event carries the real status.
        expect(d.status).toBe(DecisionStatus.Open);
    });

    it('is false before the deadline', () => {
        expect(isAwaitingResolution(decision({closesAt: future}), now)).toBe(false);
    });

    it('is false for a decision with no deadline, and for an already-resolved one', () => {
        expect(isAwaitingResolution(decision({closesAt: null}), now)).toBe(false);
        expect(isAwaitingResolution(decision({closesAt: past, status: DecisionStatus.Expired}), now)).toBe(
            false,
        );
    });
});

describe('decisionsInDisplayOrder', () => {
    it('puts open decisions first and keeps server order within each group', () => {
        const rows = [
            decision({id: 'r1', status: DecisionStatus.Decided}),
            decision({id: 'o1', status: DecisionStatus.Open}),
            decision({id: 'r2', status: DecisionStatus.Blocked}),
            decision({id: 'o2', status: DecisionStatus.Open}),
        ];
        expect(decisionsInDisplayOrder(rows).map(d => d.id)).toEqual(['o1', 'o2', 'r1', 'r2']);
    });
});

describe('normalizeDecision', () => {
    it('accepts the int form of both enums - the gateway may serialise them either way', () => {
        const raw = {
            ...decision(),
            status: 2 as unknown as DecisionStatus,
            myVoteKind: 2 as unknown as DecisionVoteKind,
        };
        const normalized = normalizeDecision(raw);
        expect(normalized.status).toBe(DecisionStatus.Blocked);
        expect(normalized.myVoteKind).toBe(DecisionVoteKind.Block);
    });

    it('leaves the string form alone', () => {
        const normalized = normalizeDecision(
            decision({
                status: DecisionStatus.Expired,
                myVoteKind: DecisionVoteKind.Abstain,
            }),
        );
        expect(normalized.status).toBe(DecisionStatus.Expired);
        expect(normalized.myVoteKind).toBe(DecisionVoteKind.Abstain);
    });

    it('defaults the two arrays so nothing downstream has to null-check them', () => {
        const raw = {...decision(), options: undefined, blocks: undefined} as unknown as Decision;
        const normalized = normalizeDecision(raw);
        expect(normalized.options).toEqual([]);
        expect(normalized.blocks).toEqual([]);
    });

    it('reports "no vote" as null rather than inventing an abstention', () => {
        expect(normalizeDecision(decision()).myVoteKind).toBeNull();
    });
});
