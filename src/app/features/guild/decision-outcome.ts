import {Decision, DecisionBlock, DecisionOption, DecisionStatus} from '../../dtos/response/decision.dto';

/**
 * The rules that make a decision not a poll, as pure functions.
 *
 * <p>They live here rather than inside the component for one reason: every one of them is a
 * rule a majority-rule reflex gets wrong, and a rule that is asserted by a spec is a rule that
 * survives the next person who "just adds a sort by support".</p>
 */

/** What an option's row is: eligible to carry, out because somebody blocked it, or the outcome. */
export type OptionStanding = 'carried' | 'blocked' | 'eligible';

/**
 * Options in the order they are drawn: `position`, then title as a tiebreak.
 *
 * <p>Never `supportCount`. Sorting by support turns the list into a leaderboard, and a
 * leaderboard puts a blocked option with three supporters at the top - which is precisely the
 * outcome this module exists to refuse.</p>
 */
export function optionsInDisplayOrder(decision: Decision): DecisionOption[] {
    return [...decision.options].sort((a, b) =>
        a.position - b.position || a.title.localeCompare(b.title));
}

/**
 * Whether this option could still be carried.
 *
 * <p>One reasoned block is enough. `supportCount` is not consulted, deliberately - there is no
 * amount of support that outvotes an objection.</p>
 */
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

/**
 * The objections aimed at the decision itself rather than at any option.
 *
 * <p>A distinct, supported gesture - "I don't think we should be deciding this at all" - and it
 * needs its own affordance and its own place on screen. Folding these in with per-option
 * objections would file a whole-decision veto under whichever option happened to be first.</p>
 */
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

/**
 * Progress toward quorum.
 *
 * <p>Counted from supports plus blocks, because **abstentions do not count toward quorum** -
 * that is the whole difference between `Expired` and `Decided` for a quiet house. An abstention
 * is not visible in this payload at all, which conveniently makes the wrong answer unreachable.</p>
 */
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

/**
 * `closesAt` has passed but the decision is still `Open`.
 *
 * <p>Not an error, and **not** a status the client may apply itself: the server resolves within
 * five minutes of the deadline, so a countdown hitting zero means "waiting for the server",
 * which is what this renders. Flipping the badge locally would show `Expired` on a decision
 * that is about to come back `Decided`.</p>
 */
export function isAwaitingResolution(decision: Decision, now: number = Date.now()): boolean {
    if (!isDecisionOpen(decision) || !decision.closesAt) return false;
    const closes = new Date(decision.closesAt).getTime();
    return Number.isFinite(closes) && closes <= now;
}

/**
 * The one-line answer to "so what happened", keyed for i18n.
 *
 * <p>`Blocked` reads as "we couldn't agree", never as a near-miss with a runner-up: there is no
 * least-hated option here, on purpose.</p>
 */
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

/**
 * Open decisions first, then the resolved ones, newest-looking first within each group.
 *
 * <p>Ids are opaque and there is no `createdAt` on the DTO, so within a group the order the
 * server sent is preserved rather than invented from an id comparison.</p>
 */
export function decisionsInDisplayOrder(decisions: readonly Decision[]): Decision[] {
    const open = decisions.filter(isDecisionOpen);
    const resolved = decisions.filter(isDecisionResolved);
    return [...open, ...resolved];
}
