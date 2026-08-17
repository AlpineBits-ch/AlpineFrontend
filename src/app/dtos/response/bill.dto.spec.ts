import {describe, expect, it} from 'vitest';
import {
    BillOccurrence,
    BillStatus,
    billState,
    canPostWithoutAmount,
    isBillOutstanding,
    normalizeBill,
    normalizeBillStatus,
    normalizeRecurrenceUnit,
    normalizeRecurringExpense,
    RecurrenceUnit,
    RecurringExpense,
    recurringExpenseError,
} from './bill.dto';
import {ExpenseCategory, ExpenseSplitKind} from './ledger.dto';

function bill(overrides: Partial<BillOccurrence> = {}): BillOccurrence {
    return {
        id: 'b1',
        recurringExpenseId: 'r1',
        channelId: 'c1',
        description: 'Rent',
        dueAt: '2026-09-01T00:00:00Z',
        amountMinor: 85000,
        currency: 'CHF',
        status: BillStatus.Pending,
        needsAmount: false,
        isOverdue: false,
        ...overrides,
    };
}

function schedule(overrides: Partial<RecurringExpense> = {}): RecurringExpense {
    return {
        id: 'r1',
        channelId: 'c1',
        description: 'Rent',
        amountMinor: 85000,
        currency: 'CHF',
        payerUserId: 'u1',
        splitKind: ExpenseSplitKind.Equal,
        category: ExpenseCategory.Rent,
        recurrenceUnit: RecurrenceUnit.Month,
        recurrenceInterval: 1,
        anchorAt: '2026-01-01T00:00:00Z',
        nextDueAt: '2026-09-01T00:00:00Z',
        leadDays: 3,
        autoPost: false,
        isPaused: false,
        createdByUserId: 'u1',
        shares: [],
        ...overrides,
    };
}

describe('billState', () => {
    it('reads a pending, on-time bill as due', () => {
        expect(billState(bill())).toBe('due');
    });

    it('reads a pending, late bill as overdue', () => {
        expect(billState(bill({isOverdue: true}))).toBe('overdue');
    });

    it('resolves posted and skipped ahead of any lateness', () => {
        expect(billState(bill({status: BillStatus.Posted, isOverdue: true}))).toBe('posted');
        expect(billState(bill({status: BillStatus.Skipped, isOverdue: true}))).toBe('skipped');
    });

    /**
     * The two call for different actions - one needs money moved, the other needs somebody to open
     * the post - so a bill that is both must not be reported as merely late, or the house waits on
     * a figure nobody was asked for.
     */
    it('reports a bill that is both late and amountless as needing an amount', () => {
        expect(billState(bill({needsAmount: true, isOverdue: true}))).toBe('needs-amount');
    });
});

describe('isBillOutstanding', () => {
    it('counts only pending periods', () => {
        expect(isBillOutstanding(bill())).toBe(true);
        expect(isBillOutstanding(bill({status: BillStatus.Posted}))).toBe(false);
        expect(isBillOutstanding(bill({status: BillStatus.Skipped}))).toBe(false);
    });
});

describe('canPostWithoutAmount', () => {
    it('is false for a bill nobody has named a figure for', () => {
        expect(canPostWithoutAmount(bill({amountMinor: null, needsAmount: true}))).toBe(false);
    });

    it('treats a zero amount as a real figure rather than as absence', () => {
        expect(canPostWithoutAmount(bill({amountMinor: 0}))).toBe(true);
    });
});

describe('recurringExpenseError', () => {
    it('refuses auto-post on a bill whose amount varies', () => {
        expect(recurringExpenseError({amountMinor: null, autoPost: true})).toBe('auto-post-needs-amount');
    });

    it('allows auto-post with a fixed amount, and a varying bill that does not auto-post', () => {
        expect(recurringExpenseError({amountMinor: 85000, autoPost: true})).toBeNull();
        expect(recurringExpenseError({amountMinor: null, autoPost: false})).toBeNull();
    });
});

describe('normalizeBill', () => {
    /**
     * The load-bearing case. `Math.trunc(undefined)` is `NaN`, which formats as something no
     * currency has ever had, and a `0` here would tell the house a varying bill costs nothing.
     */
    it('keeps a null amount null rather than truncating it to zero or NaN', () => {
        expect(normalizeBill(bill({amountMinor: null})).amountMinor).toBeNull();
    });

    it('truncates a fractional amount to whole minor units', () => {
        expect(normalizeBill(bill({amountMinor: 1234.9})).amountMinor).toBe(1234);
    });

    it('collapses an ordinal status to its name', () => {
        expect(normalizeBill(bill({status: 1 as unknown as BillStatus})).status).toBe(BillStatus.Posted);
    });
});

describe('normalizeBillStatus', () => {
    /**
     * Pending is the only reading that keeps an unrecognised bill on the upcoming board. Guessing
     * Posted would make an obligation nobody has met vanish from the one screen that shows it.
     */
    it('falls back to Pending for a status this build does not know', () => {
        expect(normalizeBillStatus('Disputed')).toBe(BillStatus.Pending);
        expect(normalizeBillStatus(99)).toBe(BillStatus.Pending);
        expect(normalizeBillStatus(null)).toBe(BillStatus.Pending);
    });
});

describe('normalizeRecurrenceUnit', () => {
    it('accepts both the name and the ordinal', () => {
        expect(normalizeRecurrenceUnit('Week')).toBe(RecurrenceUnit.Week);
        expect(normalizeRecurrenceUnit(3)).toBe(RecurrenceUnit.Year);
    });

    it('falls back to Month for anything it does not recognise', () => {
        expect(normalizeRecurrenceUnit('Fortnight')).toBe(RecurrenceUnit.Month);
    });
});

describe('normalizeRecurringExpense', () => {
    it('keeps a varying schedule varying', () => {
        expect(normalizeRecurringExpense(schedule({amountMinor: null})).amountMinor).toBeNull();
    });

    it('collapses ordinal enums and survives an absent shares array', () => {
        const normalized = normalizeRecurringExpense(
            schedule({
                splitKind: 1 as unknown as ExpenseSplitKind,
                category: 2 as unknown as ExpenseCategory,
                recurrenceUnit: 0 as unknown as RecurrenceUnit,
                shares: undefined as unknown as [],
            }),
        );

        expect(normalized.splitKind).toBe(ExpenseSplitKind.Shares);
        expect(normalized.category).toBe(ExpenseCategory.Rent);
        expect(normalized.recurrenceUnit).toBe(RecurrenceUnit.Day);
        expect(normalized.shares).toEqual([]);
    });
});
