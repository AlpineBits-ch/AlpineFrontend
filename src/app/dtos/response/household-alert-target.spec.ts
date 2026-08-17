import {describe, expect, it} from 'vitest';
import {HouseholdAlertKind, householdAlertTarget} from './household-alert.dto';

describe('householdAlertTarget', () => {
    it('routes the chore kinds to an occurrence', () => {
        expect(householdAlertTarget(HouseholdAlertKind.ChoreDue)).toBe('chore-occurrence');
        expect(householdAlertTarget(HouseholdAlertKind.ChoreNudge)).toBe('chore-occurrence');
        expect(householdAlertTarget(HouseholdAlertKind.ChoreReassigned)).toBe('chore-occurrence');
    });

    it('routes the two amountless bill kinds to the bill occurrence', () => {
        expect(householdAlertTarget(HouseholdAlertKind.LedgerBillDue)).toBe('bill');
        expect(householdAlertTarget(HouseholdAlertKind.LedgerBillNeedsAmount)).toBe('bill');
    });

    /**
     * The one trap in the table. `ledger.bill_posted` targets the <b>expense</b> the bill became,
     * not the occurrence its two siblings point at - a router written by analogy looks up an
     * expense id in the bill list, finds nothing, and silently opens the channel instead.
     */
    it('routes ledger.bill_posted to the expense, unlike its sibling bill kinds', () => {
        expect(householdAlertTarget(HouseholdAlertKind.LedgerBillPosted)).toBe('expense');
        expect(householdAlertTarget(HouseholdAlertKind.LedgerBillPosted))
            .not.toBe(householdAlertTarget(HouseholdAlertKind.LedgerBillDue));
    });

    it('routes the maintenance kinds to an asset', () => {
        expect(householdAlertTarget(HouseholdAlertKind.MaintenanceDue)).toBe('maintenance-asset');
        expect(householdAlertTarget(HouseholdAlertKind.MaintenanceWarranty)).toBe('maintenance-asset');
        expect(householdAlertTarget(HouseholdAlertKind.MaintenanceBroken)).toBe('maintenance-asset');
    });

    it('routes the wave-one kinds where they always went', () => {
        expect(householdAlertTarget(HouseholdAlertKind.LedgerExpense)).toBe('expense');
        expect(householdAlertTarget(HouseholdAlertKind.LedgerSettlement)).toBe('settlement');
        expect(householdAlertTarget(HouseholdAlertKind.DecisionOpened)).toBe('decision');
        expect(householdAlertTarget(HouseholdAlertKind.DecisionBlocked)).toBe('decision');
        expect(householdAlertTarget(HouseholdAlertKind.PantryRestock)).toBe('list-item');
        expect(householdAlertTarget(HouseholdAlertKind.MealsCookingToday)).toBe('meal-plan-entry');
    });

    /**
     * `pantry.expiring` targets its channel by design, and so does every kind added after this
     * build shipped - an unrecognised kind is not an error, it is a link to the right board.
     */
    it('falls back to the channel for a batched kind and for one it has never heard of', () => {
        expect(householdAlertTarget(HouseholdAlertKind.PantryExpiring)).toBe('channel');
        expect(householdAlertTarget('something.invented.next.quarter')).toBe('channel');
        expect(householdAlertTarget('')).toBe('channel');
    });
});
