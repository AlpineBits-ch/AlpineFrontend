import {ExpenseCategory, ExpenseSplitKind, normalizeExpenseCategory, normalizeSplitKind} from './ledger.dto';

/**
 * Bills: the recurring-expense schedule, and the dated instances it generates. Money is whole minor
 * units, and `amountMinor` may be null, meaning the amount varies. Null is not zero.
 */

/** The step between due dates, in calendar units rather than a plain day count. */
export enum RecurrenceUnit {
    Day = 'Day',
    Week = 'Week',
    Month = 'Month',
    Year = 'Year',
}

const RECURRENCE_UNIT_BY_ORDINAL: readonly RecurrenceUnit[] = [
    RecurrenceUnit.Day,
    RecurrenceUnit.Week,
    RecurrenceUnit.Month,
    RecurrenceUnit.Year,
];

/** Where one generated instance has got to. */
export enum BillStatus {
    /** Generated and waiting. For a variable bill, also "nobody has said what it cost". */
    Pending = 'Pending',
    /** Turned into a real expense; {@link BillOccurrence.expenseId} points at it. */
    Posted = 'Posted',
    /** Not charged this period. Distinct from deleting the schedule, which loses future periods too. */
    Skipped = 'Skipped',
}

const BILL_STATUS_BY_ORDINAL: readonly BillStatus[] = [
    BillStatus.Pending,
    BillStatus.Posted,
    BillStatus.Skipped,
];

export interface RecurringExpenseShare {
    userId: string;
    /** A weight under `Shares`, that person's exact minor units under `Exact`, ignored under `Equal`. */
    shareValue: number;
}

/**
 * A schedule: the template each period is generated from, neither a bill nor an expense.
 * `autoPost` is only legal with a fixed `amountMinor`; editing moves pending bills, never regenerates.
 */
export interface RecurringExpense {
    id: string;
    channelId: string;
    description: string;
    /** Null means the amount varies and each period waits for a figure. Never rendered as zero. */
    amountMinor: number | null;
    currency: string;
    payerUserId: string;
    splitKind: ExpenseSplitKind;
    category: ExpenseCategory;
    recurrenceUnit: RecurrenceUnit;
    recurrenceInterval: number;
    /** The first due date. The cadence steps from here, so editing it re-phases everything. */
    anchorAt: string;
    nextDueAt: string;
    /** 0-30. How far ahead each period is generated and announced. */
    leadDays: number;
    autoPost: boolean;
    isPaused: boolean;
    createdByUserId: string;
    shares: RecurringExpenseShare[];
}

/** One generated period of a schedule: the obligation itself. `needsAmount` and `isOverdue` are server-computed. */
export interface BillOccurrence {
    id: string;
    recurringExpenseId: string;
    channelId: string;
    description: string;
    dueAt: string;
    /** Null until somebody says what this period cost. Not zero. */
    amountMinor: number | null;
    currency: string;
    status: BillStatus;
    /** Set once posted, and it is the expense id, which is what a deep link should open. */
    expenseId?: string | null;
    postedByUserId?: string | null;
    skippedByUserId?: string | null;
    skipReason?: string | null;
    /** Pending with nobody having named a figure. The cue to ask for one, not to offer "post". */
    needsAmount: boolean;
    /** Pending and past its due date. */
    isOverdue: boolean;
}

// ── Derived state ───────────────────────────────────────────────────────────

/** How one bill row should read. `needs-amount` resolves ahead of `overdue`; both can be true. */
export type BillState = 'posted' | 'skipped' | 'needs-amount' | 'overdue' | 'due';

export function billState(bill: BillOccurrence): BillState {
    if (bill.status === BillStatus.Posted) return 'posted';
    if (bill.status === BillStatus.Skipped) return 'skipped';
    if (bill.needsAmount) return 'needs-amount';
    return bill.isOverdue ? 'overdue' : 'due';
}

/** Still owed: generated, not yet posted and not waived. What the upcoming board is made of. */
export function isBillOutstanding(bill: BillOccurrence): boolean {
    return bill.status === BillStatus.Pending;
}

/** Whether posting this bill can succeed without the caller naming a figure. */
export function canPostWithoutAmount(bill: BillOccurrence): boolean {
    return bill.amountMinor != null;
}

/** Why a schedule draft is not acceptable, or `null` when it is. `autoPost` with a varying amount is a 400. */
export function recurringExpenseError(
    draft: Pick<RecurringExpense, 'amountMinor' | 'autoPost'>,
): 'auto-post-needs-amount' | null {
    return draft.autoPost && draft.amountMinor == null ? 'auto-post-needs-amount' : null;
}

export const BILL_LIMITS = {
    /** `MaxDescriptionLength`, shared with the expense form. */
    descriptionMaxLength: 200,
    leadDaysMin: 0,
    leadDaysMax: 30,
    recurrenceIntervalMin: 1,
    recurrenceIntervalMax: 365,
    /** `MaxSkipReasonLength`. Optional. */
    skipReasonMaxLength: 500,
} as const;

// ── Realtime (server → client) ──────────────────────────────────────────────

export interface RecurringExpenseCreated {
    guildId: string;
    channelId: string;
    recurringExpense: RecurringExpense;
}

export type RecurringExpenseUpdated = RecurringExpenseCreated;

export interface RecurringExpenseDeleted {
    guildId: string;
    channelId: string;
    recurringExpenseId: string;
}

export interface BillOccurrenceCreated {
    guildId: string;
    channelId: string;
    bill: BillOccurrence;
}

export type BillOccurrenceUpdated = BillOccurrenceCreated;

// ── Normalization ───────────────────────────────────────────────────────────

/** Makes a schedule safe to hold: enums are names whichever way they arrived, and the amount is an integer or null. */
export function normalizeRecurringExpense(raw: RecurringExpense): RecurringExpense {
    return {
        ...raw,
        splitKind: normalizeSplitKind(raw.splitKind),
        category: normalizeExpenseCategory(raw.category),
        recurrenceUnit: normalizeRecurrenceUnit(raw.recurrenceUnit),
        amountMinor: raw.amountMinor == null ? null : Math.trunc(raw.amountMinor),
        shares: raw.shares ?? [],
    };
}

export function normalizeBill(raw: BillOccurrence): BillOccurrence {
    return {
        ...raw,
        status: normalizeBillStatus(raw.status),
        amountMinor: raw.amountMinor == null ? null : Math.trunc(raw.amountMinor),
    };
}

export function normalizeRecurrenceUnit(
    value: RecurrenceUnit | number | string | null | undefined,
): RecurrenceUnit {
    if (typeof value === 'number') return RECURRENCE_UNIT_BY_ORDINAL[value] ?? RecurrenceUnit.Month;
    return (RECURRENCE_UNIT_BY_ORDINAL as readonly string[]).includes(value as string)
        ? (value as RecurrenceUnit)
        : RecurrenceUnit.Month;
}

/** `Pending` for anything unrecognised, which is the reading that keeps a bill on the upcoming board. */
export function normalizeBillStatus(value: BillStatus | number | string | null | undefined): BillStatus {
    if (typeof value === 'number') return BILL_STATUS_BY_ORDINAL[value] ?? BillStatus.Pending;
    return (BILL_STATUS_BY_ORDINAL as readonly string[]).includes(value as string)
        ? (value as BillStatus)
        : BillStatus.Pending;
}
