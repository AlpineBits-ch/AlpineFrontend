/**
 * `guild.HouseholdAlert` - the one envelope every household notification arrives in.
 *
 * <p>Household modules broadcast two very different things and conflating them is the mistake this
 * file exists to prevent. The `guild.*Created`-style events are <b>collaborative broadcasts</b>:
 * the row that changed, sent to whoever is looking at that channel, so two open clients agree.
 * They must never buzz a phone - somebody ticking milk off the shopping list is not worth waking
 * anyone up for. An <b>alert</b> is the opposite: few recipients, each of whom needs to know with
 * the app closed, so it is the only household event this client turns into an OS notification.</p>
 *
 * <p><b>One event for every kind, deliberately.</b> Kinds keep being added, and a client that had
 * to subscribe to `guild.SomethingNewAlert` would silently stop being told about it. Which is why
 * {@link HouseholdAlert.kind} is a plain `string` here rather than the union below: an unknown kind
 * still carries a server-written title and body and still deep-links on `targetId`, so it renders
 * correctly on a build that predates it.</p>
 *
 * <p>The server decides the recipients, and it has already applied every rule worth knowing:
 * `ViewChannel` filtering, quiet-hours deferral, the once-per-thing guarantees, and the cutoffs
 * that stop a guild returning from an outage buzzing everyone at once. Nothing here re-filters.</p>
 */

/**
 * The kinds the server sends today. Reference values for routing - never an exhaustive list, and
 * never a validity check: see the note above about kinds being added.
 */
export const HouseholdAlertKind = {
    /** The assignee's turn is due. `targetId` is the occurrence. */
    ChoreDue: 'chore.due',
    /** Everyone with a share, plus the payer when somebody else recorded it. Create only. */
    LedgerExpense: 'ledger.expense',
    /** The counterparty; both parties when a third person recorded it. */
    LedgerSettlement: 'ledger.settlement',
    /** Everyone who can see the channel, except the author. */
    DecisionOpened: 'decision.opened',
    /** The author and anyone who already voted, except the blocker. Fires on the transition only. */
    DecisionBlocked: 'decision.blocked',
    /** Only members whose home status is `Out` or `OnMyWay`. `targetId` is the list item. */
    PantryRestock: 'pantry.restock',
    /** Batched per pantry, so <b>`targetId` is a channel id</b>, not an item. */
    PantryExpiring: 'pantry.expiring',
} as const;

export type HouseholdAlertKind = typeof HouseholdAlertKind[keyof typeof HouseholdAlertKind];

export interface HouseholdAlert {
    guildId: string;
    /**
     * Where it happened - and what a click should open. Every kind carries one, including
     * `pantry.expiring`, whose `targetId` names the same channel.
     */
    channelId: string;
    /** Routed on, never validated against {@link HouseholdAlertKind} - more kinds are coming. */
    kind: string;
    /** An occurrence, expense, settlement, decision, list item or channel, depending on `kind`. */
    targetId: string;
    /**
     * Written server-side, in the recipient's terms ("Milk, Yoghurt and 2 more are about to go
     * off"). Rendered as given: a client that composed its own copy per kind would have nothing to
     * say for a kind it does not know about, which is the case this envelope exists to survive.
     */
    title: string;
    body: string;
    /** Kind-specific extras - `chore.due` carries `choreId`/`dueAt`, `pantry.expiring` `items`. */
    data?: Record<string, unknown> | null;
}

/**
 * Whether an arriving payload is usable.
 *
 * <p>Guarded rather than assumed because this runs inside a SignalR callback: a throw there kills
 * the rest of that dispatch, taking every later handler for the same event with it. A payload
 * without a title or a target is not a notification anybody could act on, so it is dropped.</p>
 */
export function isHouseholdAlert(raw: unknown): raw is HouseholdAlert {
    if (!raw || typeof raw !== 'object') return false;
    const candidate = raw as Partial<HouseholdAlert>;
    return typeof candidate.kind === 'string' && !!candidate.kind
        && typeof candidate.targetId === 'string' && !!candidate.targetId
        && typeof candidate.title === 'string' && !!candidate.title;
}

/**
 * Identity of an alert, for dedupe across a reconnect.
 *
 * <p>Kind <i>and</i> target: one occurrence can legitimately produce a `chore.due` and later a
 * different kind about the same id, and a pantry channel produces one `pantry.expiring` per sweep
 * where the target is the channel itself. Keying on `targetId` alone would silence the second.</p>
 */
export function householdAlertKey(alert: HouseholdAlert): string {
    return `${alert.kind}:${alert.targetId}`;
}

/**
 * The keys the household push carries, so a desktop notification click has what a deep-link needs.
 *
 * <p>Deliberately the same shape as the push payload (`type: "household"`, plus `kind` and
 * `targetId`) with the two ids the click handler needs to get there. `extra` is a string map end to
 * end - the Windows toast bridge marshals it as one - so nothing structured goes in here.</p>
 */
export function householdAlertExtra(alert: HouseholdAlert): Record<string, string> {
    return {
        type: 'household',
        kind: alert.kind,
        targetId: alert.targetId,
        guildId: alert.guildId,
        channelId: alert.channelId,
    };
}
