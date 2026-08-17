/**
 * Moving out: how somebody leaves a household, and what the house has to decide first.
 *
 * <p><b>A household has no kick.</b> The `Household` preset leaves the Moderation module off, which
 * strips `KickMembers` and `BanMembers` for everybody including the owner - so this endpoint is the
 * only way a flatmate who has moved out is removed, and a member list that offers no move-out in a
 * household offers no removal at all.</p>
 *
 * <p>It is not a moderation action and must not be drawn as one. Its whole shape is about
 * unwinding shared obligations: the rota, the assignments, and above all the money.</p>
 */

/** What one ledger channel still says this member owes, or is owed. */
export interface MoveOutOutstanding {
    channelId: string;
    /** ISO-4217, per ledger channel - a house may run more than one and they need not agree. */
    currency: string;
    /** `+` means the house owes them; `-` means they owe the house. Whole minor units. */
    netMinor: number;
}

/**
 * The `409` body: they are not settled up.
 *
 * <p>Render it as a decision, never as a failure. The two answers are "settle up first" and "write
 * it off", and only the house can pick between them - which is why the server refuses to guess and
 * why `writeOffBalances` has to be sent deliberately.</p>
 */
export interface MoveOutConflict {
    error: string;
    outstanding: MoveOutOutstanding[];
}

/** One debt the house agreed to stop counting. Not a payment - see {@link MoveOutSummary}. */
export interface WrittenOffBalance {
    fromUserId: string;
    toUserId: string;
    amountMinor: number;
}

/**
 * What actually happened, so the caller can say so rather than just closing a dialog.
 *
 * <p>Two of these counts are things the house still has to resolve and should be surfaced, not
 * summed into a total: `choresPaused` are the chores that named this person as the fixed assignee
 * and are now waiting for somebody to pick them up, and `choresDropped` are the ones deleted
 * outright because the rota had nobody left in it.</p>
 *
 * <p>Their <b>completed chore history is deliberately left alone</b> and no count here reports
 * otherwise. Rewriting it would move everyone else's fairness balance on the day a flatmate leaves,
 * which is the one day nobody would think to check it.</p>
 */
export interface MoveOutSummary {
    userId: string;
    /** Unfinished occurrences handed to the next lightest-loaded member. */
    choresReassigned: number;
    choresDropped: number;
    choresPaused: number;
    listItemsUnassigned: number;
    /**
     * Empty unless `writeOffBalances` was sent.
     *
     * <p>These are recorded settlements that zero the member out. <b>No money moved.</b> It is the
     * house agreeing to stop counting the debt, it is written to the audit log as exactly that, and
     * the confirm dialog has to have said so before this is ever non-empty.</p>
     */
    balancesWrittenOff: WrittenOffBalance[];
}

/** `guild.MemberMovedOut` - broadcast guild-wide, like the removal it is. */
export interface MemberMovedOut {
    guildId: string;
    userId: string;
}

/** Whether a summary leaves the house with something to sort out. */
export function hasUnresolvedChores(summary: MoveOutSummary): boolean {
    return summary.choresPaused > 0 || summary.choresDropped > 0;
}

/** Whether the `409` is worth showing a currency total for, or just a "not settled" line. */
export function totalOutstandingMinor(outstanding: readonly MoveOutOutstanding[], currency: string): number {
    return outstanding
        .filter(o => o.currency === currency)
        .reduce((sum, o) => sum + o.netMinor, 0);
}
