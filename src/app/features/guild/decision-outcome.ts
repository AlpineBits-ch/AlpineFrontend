import {Decision, DecisionBlock, DecisionOption, DecisionStatus} from '../../dtos/response/decision.dto';

/** What an option's row is: eligible to carry, out because somebody blocked it, or the outcome. */
export type OptionStanding = 'carried' | 'blocked' | 'eligible';

/** Ordered by `position` then title; never by `supportCount` - that would let a blocked option with more support rank above eligible ones. */
export function optionsInDisplayOrder(decision: Decision): DecisionOption[] {
    return [...decision.options].sort((a, b) =>
        a.position - b.position || a.title.localeCompare(b.title));
}

/** One reasoned block is enough to disqualify an option; `supportCount` is never consulted, no amount of support outvotes an objection. */
export function canOptionCarry(option: DecisionOption): boolean {
    return !option.isBlocked;
}

export function optionStanding(decision: Decision, option: DecisionOption): OptionStanding {
    if (decision.outcomeOptionId === option.id) return 'carried';
    return option.isBlocked ? 'blocked' : 'eligible';
}

/** The objections aimed at one option. */
export function blocksForOption(decision: Decision, optionId: string): DecisionBlock[] {
    return decision.blocks.filter(b => b.optionId === optionId);
}

/** Objections aimed at the decision itself, not any option; folding them into per-option blocks would file a whole-decision veto under whichever option happened to be first. */
export function wholeDecisionBlocks(decision: Decision): DecisionBlock[] {
    return decision.blocks.filter(b => b.optionId === null || b.optionId === undefined);
}

export interface QuorumProgress {
    /** Non-abstain votes cast: every support, plus every block. */
    cast: number;
    /** What is needed, or null when the decision has no threshold. */
    required: number | null;
    met: boolean;
}

/** Counted from supports plus blocks; abstentions never count toward quorum, which is the whole difference between `Expired` and `Decided`. */
export function quorumProgress(decision: Decision): QuorumProgress {
    const cast = decision.options.reduce((sum, o) => sum + o.supportCount, 0) + decision.blocks.length;
    const required = decision.quorum ?? null;
    return {cast, required, met: required === null || cast >= required};
}

/** Still taking votes. The only state with vote affordances. */
export function isDecisionOpen(decision: Decision): boolean {
    return decision.status === DecisionStatus.Open;
}

/** Reached an end - decided, blocked, cancelled or expired. Nothing further can be voted. */
export function isDecisionResolved(decision: Decision): boolean {
    return !isDecisionOpen(decision);
}

/** `closesAt` has passed but status is still `Open`; never apply `Expired` locally, the server resolves within five minutes and flipping the badge early would misreport a decision about to come back `Decided`. */
export function isAwaitingResolution(decision: Decision, now: number = Date.now()): boolean {
    if (!isDecisionOpen(decision) || !decision.closesAt) return false;
    const closes = new Date(decision.closesAt).getTime();
    return Number.isFinite(closes) && closes <= now;
}

/** Keyed for i18n; `Blocked` reads as "we couldn't agree", never as a near-miss with a runner-up. */
export function decisionResultKey(decision: Decision): string {
    switch (decision.status) {
        case DecisionStatus.Decided:
            return 'DECISIONS.RESULT.DECIDED';
        case DecisionStatus.Blocked:
            return 'DECISIONS.RESULT.BLOCKED';
        case DecisionStatus.Expired:
            return 'DECISIONS.RESULT.EXPIRED';
        case DecisionStatus.Cancelled:
            return 'DECISIONS.RESULT.CANCELLED';
        default:
            return 'DECISIONS.RESULT.OPEN';
    }
}

/** Status pill styling. Kept beside the rules so a new status can't quietly borrow "open" green. */
export function decisionStatusTone(status: DecisionStatus): 'open' | 'good' | 'bad' | 'muted' {
    switch (status) {
        case DecisionStatus.Open:
            return 'open';
        case DecisionStatus.Decided:
            return 'good';
        case DecisionStatus.Blocked:
            return 'bad';
        default:
            return 'muted';
    }
}

/** Open decisions first, then resolved; within each group the server's own order is preserved since ids are opaque and there's no `createdAt` to sort by. */
export function decisionsInDisplayOrder(decisions: readonly Decision[]): Decision[] {
    const open = decisions.filter(isDecisionOpen);
    const resolved = decisions.filter(isDecisionResolved);
    return [...open, ...resolved];
}
