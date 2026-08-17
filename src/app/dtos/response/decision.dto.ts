/**
 * A house decision, as `Guild.Application.Dtos.Response.DecisionDto` serialises it.
 *
 * <p>This is not a poll. An option is carried when quorum is met **and nobody has blocked it** -
 * one reasoned block beats any amount of support. Everything downstream of this file exists to
 * keep that rule visible: {@link DecisionOption.isBlocked} is a hard state, not a tally
 * adjustment, and {@link Decision.blocks} are objections to resolve, not downvotes.</p>
 */

/** Server order, and the fallback used when the enum arrives as an int - see {@link normalizeDecision}. */
export enum DecisionStatus {
    /** Still taking votes. The only status with vote affordances. */
    Open = 'Open',
    /** One option carried: quorum met, nobody blocked it. `outcomeOptionId` names it. */
    Decided = 'Decided',
    /**
     * Every option was vetoed. Deliberately *not* "the least-hated option wins" - "we couldn't
     * agree" is a result, and rendering a runner-up here would invent an outcome the house
     * never reached.
     */
    Blocked = 'Blocked',
    /** Soft-cancelled by whoever may open decisions. No outcome was reached, and none was refused. */
    Cancelled = 'Cancelled',
    /** `closesAt` passed with quorum never reached. Abstentions never counted toward it. */
    Expired = 'Expired',
}

export enum DecisionVoteKind {
    /** Requires an `optionId`; `400` without one. */
    Support = 'Support',
    /** Present but not counted toward quorum - "I'd rather not weigh in" is not a vote. */
    Abstain = 'Abstain',
    /** Requires a `reason`; `400` without one. `optionId: null` objects to the whole decision. */
    Block = 'Block',
}

/**
 * The declaration order of the CLR enums, indexed.
 *
 * <p>The AsyncAPI schema flags both enums as "int when serialised by a host without
 * JsonStringEnumConverter (see the gateway)". Which host serialised a given payload is not
 * something a client can know, so both shapes are accepted and normalised on the way in rather
 * than left for every `@if` in the template to guess at.</p>
 */
const DECISION_STATUS_BY_ORDINAL: readonly DecisionStatus[] = [
    DecisionStatus.Open,
    DecisionStatus.Decided,
    DecisionStatus.Blocked,
    DecisionStatus.Cancelled,
    DecisionStatus.Expired,
];

const DECISION_VOTE_KIND_BY_ORDINAL: readonly DecisionVoteKind[] = [
    DecisionVoteKind.Support,
    DecisionVoteKind.Abstain,
    DecisionVoteKind.Block,
];

export interface DecisionOption {
    id: string;
    title: string;
    /** Display order, and the *only* order this app sorts options by. Never `supportCount`. */
    position: number;
    /**
     * How many members support this option. A secondary number, never a ranking key: an option
     * with three supporters and one block does not win, so sorting or highlighting by this
     * would draw the wrong winner on screen.
     */
    supportCount: number;
    /**
     * Somebody blocked this option. It **cannot** be carried, whatever `supportCount` says.
     * Render as a hard state - the option is out - not as a penalty applied to the tally.
     */
    isBlocked: boolean;
}

export interface DecisionBlock {
    userId: string;
    /** `null` objects to the whole decision rather than to one option. */
    optionId?: string | null;
    /** Never empty - the server rejects a block without one. This is the thing to render. */
    reason: string;
}

export interface Decision {
    id: string;
    channelId: string;
    title: string;
    description?: string | null;
    createdByUserId: string;
    /**
     * ISO 8601, or null for "open until someone closes it". A decision with one resolves
     * automatically **within 5 minutes** of it passing - so a client countdown reaching zero
     * must not flip `status` itself; wait for `guild.DecisionUpdated` / `guild.DecisionClosed`.
     */
    closesAt?: string | null;
    /** Non-abstain votes needed. Null means no threshold. */
    quorum?: number | null;
    status: DecisionStatus;
    /** Set only on {@link DecisionStatus.Decided}. */
    outcomeOptionId?: string | null;
    options: DecisionOption[];
    /** The objections, with their authors and reasons. Not a count - a list to work through. */
    blocks: DecisionBlock[];
    /** The caller's own vote. One per member; `PUT /vote` upserts it. */
    myVoteOptionId?: string | null;
    myVoteKind?: DecisionVoteKind | null;
}

// ── Realtime payloads ───────────────────────────────────────────────────────
// Field names are the AsyncAPI ones (`components.messages.guild_Decision*`), which wrap the
// decision in an envelope carrying the guild and channel it belongs to. All three carrying a
// decision carry the *whole* DTO, so none of them needs a merge - the payload replaces.

/** `guild.DecisionCreated` */
export interface DecisionCreated {
    guildId: string;
    channelId: string;
    decision: Decision;
}

/** `guild.DecisionUpdated` - a vote landed, or the server resolved a `closesAt`. */
export interface DecisionUpdated {
    guildId: string;
    channelId: string;
    decision: Decision;
}

/** `guild.DecisionClosed` - closed by hand or resolved on time. Terminal. */
export interface DecisionClosed {
    guildId: string;
    channelId: string;
    decision: Decision;
}

/**
 * `guild.DecisionCancelled` - the soft delete.
 *
 * <p>The odd one out: it carries **no decision object**, only the id. There is nothing to
 * replace a local copy with, so the status transition has to be applied to whatever the client
 * already holds.</p>
 */
export interface DecisionCancelled {
    guildId: string;
    channelId: string;
    decisionId: string;
}

// ── Normalization ───────────────────────────────────────────────────────────

/**
 * A decision off the wire, with both enums forced to their string form and the two arrays
 * guaranteed present.
 *
 * <p>Cheap and total: an unknown status (a newer server) is passed through as-is rather than
 * coerced to `Open`, because rendering an unrecognised terminal state as "still taking votes"
 * would offer vote buttons that the server will refuse.</p>
 */
export function normalizeDecision(raw: Decision): Decision {
    return {
        ...raw,
        status: normalizeStatus(raw.status),
        myVoteKind: normalizeVoteKind(raw.myVoteKind),
        options: raw.options ?? [],
        blocks: raw.blocks ?? [],
    };
}

function normalizeStatus(value: DecisionStatus | number | null | undefined): DecisionStatus {
    if (typeof value === 'number') return DECISION_STATUS_BY_ORDINAL[value] ?? DecisionStatus.Open;
    return (value ?? DecisionStatus.Open) as DecisionStatus;
}

function normalizeVoteKind(value: DecisionVoteKind | number | null | undefined): DecisionVoteKind | null {
    if (typeof value === 'number') return DECISION_VOTE_KIND_BY_ORDINAL[value] ?? null;
    return (value ?? null) as DecisionVoteKind | null;
}
