/**
 * `guild.HouseholdAlert`, the one envelope every household notification arrives in. The server
 * decides recipients and has already applied every filter; nothing here re-filters.
 */

/** The kinds the server sends today. Reference values for routing, never an exhaustive list or a validity check. */
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
    /** Batched per pantry, so `targetId` is a channel id, not an item. */
    PantryExpiring: 'pantry.expiring',

    /** Somebody nudged about an overdue chore. `targetId` is the occurrence; there is no sender. */
    ChoreNudge: 'chore.nudge',
    /** An absence handed this occurrence over. `targetId` is the occurrence. */
    ChoreReassigned: 'chore.reassigned',

    /** A bill is coming up. `targetId` is the bill occurrence. */
    LedgerBillDue: 'ledger.bill_due',
    /** A bill became a real expense. `targetId` is the expense, not the occurrence. */
    LedgerBillPosted: 'ledger.bill_posted',
    /** A varying bill came due with nobody having said what it cost. `targetId` is the occurrence. */
    LedgerBillNeedsAmount: 'ledger.bill_needs_amount',

    /** You are down to cook today. `targetId` is the meal plan entry. */
    MealsCookingToday: 'meals.cooking_today',

    /** A service is due. `targetId` is the asset. */
    MaintenanceDue: 'maintenance.due',
    /** A warranty is about to lapse. `targetId` is the asset. */
    MaintenanceWarranty: 'maintenance.warranty',
    /** Somebody marked it broken. `targetId` is the asset. */
    MaintenanceBroken: 'maintenance.broken',
} as const;

export type HouseholdAlertKind = (typeof HouseholdAlertKind)[keyof typeof HouseholdAlertKind];

export interface HouseholdAlert {
    guildId: string;
    /** Where it happened, and what a click should open. Every kind carries one. */
    channelId: string;
    /** Routed on, never validated against {@link HouseholdAlertKind}; more kinds are coming. */
    kind: string;
    /** An occurrence, expense, settlement, decision, list item or channel, depending on `kind`. */
    targetId: string;
    /** Written server-side in the recipient's terms, and rendered as given. */
    title: string;
    body: string;
    /** Kind-specific extras: `chore.due` carries `choreId`/`dueAt`, `pantry.expiring` `items`. */
    data?: Record<string, unknown> | null;
}

/** Whether an arriving payload is usable. One without a title or a target is dropped. */
export function isHouseholdAlert(raw: unknown): raw is HouseholdAlert {
    if (!raw || typeof raw !== 'object') return false;
    const candidate = raw as Partial<HouseholdAlert>;
    return (
        typeof candidate.kind === 'string' &&
        !!candidate.kind &&
        typeof candidate.targetId === 'string' &&
        !!candidate.targetId &&
        typeof candidate.title === 'string' &&
        !!candidate.title
    );
}

/** Identity of an alert, for dedupe across a reconnect. Kind and target; `targetId` alone is not enough. */
export function householdAlertKey(alert: HouseholdAlert): string {
    return `${alert.kind}:${alert.targetId}`;
}

/** What kind of thing an alert's `targetId` names. */
export type HouseholdAlertTarget =
    | 'chore-occurrence'
    | 'expense'
    | 'settlement'
    | 'decision'
    | 'list-item'
    | 'bill'
    | 'meal-plan-entry'
    | 'maintenance-asset'
    | 'pantry-item'
    /** The target is the channel, or the kind is one this build does not know. */
    | 'channel';

/** Where a kind's `targetId` points. `ledger.bill_posted` targets the expense, not the occurrence. */
export function householdAlertTarget(kind: string): HouseholdAlertTarget {
    switch (kind) {
        case HouseholdAlertKind.ChoreDue:
        case HouseholdAlertKind.ChoreNudge:
        case HouseholdAlertKind.ChoreReassigned:
            return 'chore-occurrence';
        case HouseholdAlertKind.LedgerExpense:
        case HouseholdAlertKind.LedgerBillPosted:
            return 'expense';
        case HouseholdAlertKind.LedgerSettlement:
            return 'settlement';
        case HouseholdAlertKind.LedgerBillDue:
        case HouseholdAlertKind.LedgerBillNeedsAmount:
            return 'bill';
        case HouseholdAlertKind.DecisionOpened:
        case HouseholdAlertKind.DecisionBlocked:
            return 'decision';
        case HouseholdAlertKind.PantryRestock:
            return 'list-item';
        case HouseholdAlertKind.MealsCookingToday:
            return 'meal-plan-entry';
        case HouseholdAlertKind.MaintenanceDue:
        case HouseholdAlertKind.MaintenanceWarranty:
        case HouseholdAlertKind.MaintenanceBroken:
            return 'maintenance-asset';
        default:
            // `pantry.expiring` lands here by design; its target already is the channel.
            return 'channel';
    }
}

export function householdAlertExtra(alert: HouseholdAlert): Record<string, string> {
    return {
        type: 'household',
        kind: alert.kind,
        targetId: alert.targetId,
        guildId: alert.guildId,
        channelId: alert.channelId,
    };
}
