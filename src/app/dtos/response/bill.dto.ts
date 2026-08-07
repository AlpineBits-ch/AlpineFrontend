import {ExpenseCategory, ExpenseSplitKind, normalizeExpenseCategory, normalizeSplitKind} from './ledger.dto';

/**
 * Bills: the recurring-expense *schedule*, and the dated instances it generates.
 *
 * <p><b>A bill is an obligation before it is an expense</b>, and that distinction is the whole
 * feature. "Rent is due Friday and you owe 850" and "Anna paid rent, you owe her 850" are different
 * sentences about different moments, and the ledger could previously only say the second. So a
 * pending bill is never rendered as ledger history: nothing has been spent yet, and nobody is owed
 * anything yet. Posting is what turns one into an {@link import('./ledger.dto').Expense}.</p>
 *
 * <p>Money is whole minor units here as everywhere - with one extra state the expense list does not
 * have: <b>`amountMinor` may be null</b>, meaning the amount varies and nobody has opened the post
 * yet. Null is not zero and must never render as `0.00`.</p>
 */

/**
 * The step between due dates.
 *
 * <p>Not the Chores module's plain `intervalDays`, and that is deliberate: rent is due on the first
 * of the month, not every thirty days. Stepping in calendar months keeps a bill anchored to its day
 * of the month, where a day count drifts a day earlier every February.</p>
 */
export enum RecurrenceUnit {
    Day = 'Day',
    Week = 'Week',
    Month = 'Month',
    Year = 'Year',
}

const RECURRENCE_UNIT_BY_ORDINAL: readonly RecurrenceUnit[] = [
    RecurrenceUnit.Day, RecurrenceUnit.Week, RecurrenceUnit.Month, RecurrenceUnit.Year,
];

/** Where one generated instance has got to. */
export enum BillStatus {
    /**
     * Generated and waiting. For a variable bill this also means "nobody has said what it cost",
     * which is the normal state of an electricity bill until it comes through the door.
     */
    Pending = 'Pending',
    /** Turned into a real expense; {@link BillOccurrence.expenseId} points at it. */
    Posted = 'Posted',
    /**
     * Deliberately not charged this period - the flat was empty in August, the landlord waived it.
     * Distinct from deleting the schedule, which would lose every future period too.
     */
    Skipped = 'Skipped',
}

const BILL_STATUS_BY_ORDINAL: readonly BillStatus[] = [
    BillStatus.Pending, BillStatus.Posted, BillStatus.Skipped,
];

export interface RecurringExpenseShare {
    userId: string;
    /** A weight under `Shares`, that person's exact minor units under `Exact`, ignored under `Equal`. */
    shareValue: number;
}

/**
 * A schedule. Not a bill and not an expense - the template each period is generated from.
 *
 * <p>Two rules the editor has to enforce rather than discover:</p>
 *
 * <ul>
 *   <li><b>`autoPost` is only legal with a fixed `amountMinor`.</b> There is nothing to post
 *       otherwise, and the server refuses the pair.</li>
 *   <li><b>Editing a schedule moves its pending bills rather than regenerating them.</b> An amount
 *       somebody typed off a paper letter survives a change to the cadence, which is why the edit
 *       dialog does not have to warn about losing it.</li>
 * </ul>
 */
export interface RecurringExpense {
    id: string;
    channelId: string;
    description: string;
    /** **Null means the amount varies** and each period waits for a figure. Never rendered as zero. */
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

/**
 * One generated period of a schedule - the obligation itself.
 *
 * <p>{@link needsAmount} and {@link isOverdue} are computed server-side rather than left to the
 * client, so every surface agrees on what "late" means and nobody re-derives the grace rules.</p>
 */
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
    /** Set once posted - and it is the **expense** id, which is what a deep link should open. */
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

/**
 * How one bill row should read.
 *
 * <p>`needs-amount` is resolved ahead of `overdue` on purpose. Both can be true, and they call for
 * different actions: one needs somebody to move money, the other needs somebody to open the post.
 * Showing the second as merely late would leave the house waiting on a figure nobody was asked
 * for.</p>
 */
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

/**
 * Whether posting this bill can succeed without the caller naming a figure.
 *
 * <p>A variable bill with no amount cannot be posted at all, so the button asks rather than
 * offering an action the server will refuse.</p>
 */
export function canPostWithoutAmount(bill: BillOccurrence): boolean {
    return bill.amountMinor != null;
}

/**
 * Why a schedule draft is not acceptable, or `null` when it is.
 *
 * <p>Only one rule needs saying: `autoPost` with a varying amount is a `400`, and a raw one next to
 * a switch the user has just flipped explains nothing.</p>
 */
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
    /** `MaxSkipReasonLength`. Optional, and worth asking for - a month with no rent gets queried. */
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

/**
 * Makes a schedule safe to hold: enums are names whichever way they arrived, and the amount is an
 * integer **or null**.
 *
 * <p>The `?? null` is the load-bearing part. `Math.trunc(undefined)` is `NaN`, which formats as
 * something no currency has ever had, and a `0` there would tell the house a varying bill costs
 * nothing.</p>
 */
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
        ? value as RecurrenceUnit
        : RecurrenceUnit.Month;
}

/**
 * `Pending` for anything unrecognised - the only reading that keeps a bill on the upcoming board.
 * Guessing `Posted` would make an obligation nobody has met disappear from the one screen that
 * exists to show it.
 */
export function normalizeBillStatus(
    value: BillStatus | number | string | null | undefined,
): BillStatus {
    if (typeof value === 'number') return BILL_STATUS_BY_ORDINAL[value] ?? BillStatus.Pending;
    return (BILL_STATUS_BY_ORDINAL as readonly string[]).includes(value as string)
        ? value as BillStatus
        : BillStatus.Pending;
}
