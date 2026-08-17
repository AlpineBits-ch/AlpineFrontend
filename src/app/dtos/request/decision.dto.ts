import {DecisionVoteKind} from '../response/decision.dto';

/** Everything `DecisionEndpoint.CreateAsync` checks before it writes, so the form can check it first. */
export const DECISION_LIMITS = {
    /** `MaxTitleLength`. */
    titleMaxLength: 150,
    /** Blank entries are dropped server-side *before* this floor is applied - so are they here. */
    minOptions: 2,
    /** `MaxOptions`. */
    maxOptions: 10,
    /** `Quorum` is rejected below this. Null means "no threshold" and is not the same as zero. */
    quorumMin: 1,
} as const;

/**
 * Why the server would refuse to open this decision, or `null` if it wouldn't.
 *
 * <p>One function so the dialog's disabled state, its inline messages and the specs cannot drift
 * apart. `closes-at-past` is the one worth stating out loud: a deadline typed a minute ago is an
 * ordinary mistake, and a bare `400` next to a date picker does not say which field it meant.</p>
 */
export type CreateDecisionProblem =
    'title-required' | 'title-too-long' | 'too-few-options' | 'too-many-options'
    | 'quorum-too-low' | 'closes-at-past' | null;

export function createDecisionProblem(body: CreateDecisionDto, now = Date.now()): CreateDecisionProblem {
    const title = body.title.trim();
    if (!title) return 'title-required';
    if (title.length > DECISION_LIMITS.titleMaxLength) return 'title-too-long';

    const options = body.options.filter(option => option.trim().length > 0);
    if (options.length < DECISION_LIMITS.minOptions) return 'too-few-options';
    if (options.length > DECISION_LIMITS.maxOptions) return 'too-many-options';

    // Null is a legal quorum - it means no threshold. A number below the floor is not.
    if (body.quorum != null && body.quorum < DECISION_LIMITS.quorumMin) return 'quorum-too-low';
    if (body.closesAt && new Date(body.closesAt).getTime() <= now) return 'closes-at-past';
    return null;
}

export interface CreateDecisionDto {
    title: string;
    description?: string | null;
    /** ISO 8601. The server resolves the decision within 5 minutes of this passing. */
    closesAt?: string | null;
    /** Non-abstain votes needed. Omit for "no threshold". */
    quorum?: number | null;
    /** Option titles, in the order they should appear. Position is assigned server-side. */
    options: string[];
}

/**
 * The upsert body for `PUT /decisions/{id}/vote` - the server's `CastDecisionVoteDto`. One vote
 * per member: this replaces whatever the caller voted before rather than adding to it, which is
 * why the UI reads "change my vote" and never "vote again".
 *
 * <p>An `Abstain` may carry an `optionId`; the server discards it (`existing.OptionId = null`), so
 * the honest thing is not to send one.</p>
 *
 * <p>Two server-side `400`s are worth enforcing in the form rather than discovering by toast:
 * {@link DecisionVoteKind.Support} needs an `optionId`, and {@link DecisionVoteKind.Block}
 * needs a `reason`. See {@link voteBodyProblem}.</p>
 */
export interface DecisionVoteDto {
    kind: DecisionVoteKind;
    /** Required for Support. For Block, `null` objects to the whole decision rather than one option. */
    optionId?: string | null;
    /** Required for Block, and only meaningful there. */
    reason?: string | null;
}

/** Why the server would reject this body, or `null` if it wouldn't. */
export type VoteBodyProblem = 'option-required' | 'reason-required' | null;

/**
 * The client-side half of the two `400`s.
 *
 * <p>Pure and exported so the form, the submit button's disabled state and the specs all agree
 * on one rule - a veto whose reasoning nobody can read is how a house ends up in a silent
 * standoff, so "reason required" has to be a precondition, not an error message after the fact.</p>
 */
export function voteBodyProblem(body: DecisionVoteDto): VoteBodyProblem {
    if (body.kind === DecisionVoteKind.Support && !body.optionId) return 'option-required';
    if (body.kind === DecisionVoteKind.Block && !body.reason?.trim()) return 'reason-required';
    return null;
}
