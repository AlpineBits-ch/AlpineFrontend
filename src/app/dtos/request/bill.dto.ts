import {ExpenseCategory, ExpenseSplitKind} from '../response/ledger.dto';
import {RecurrenceUnit} from '../response/bill.dto';

/**
 * Bill write bodies. As with expenses, what the client may *say* about a split is narrower than
 * what the server reports back: weights, never per-person amounts.
 */

export interface RecurringExpenseShareDto {
    userId: string;
    /** A weight under `Shares`. Ignored under `Equal`. */
    shareValue?: number;
}

export interface CreateRecurringExpenseDto {
    description: string;
    /**
     * Whole minor units. **Omit it for a bill whose amount varies** - the electricity the house
     * cannot know in advance - and every period is generated waiting for a figure.
     */
    amountMinor?: number;
    /** Omitted means the caller. */
    payerUserId?: string;
    splitKind: ExpenseSplitKind;
    category?: ExpenseCategory;
    recurrenceUnit: RecurrenceUnit;
    recurrenceInterval: number;
    /** The first due date. Omitted means now, which makes the first bill due immediately. */
    anchorAt?: string;
    /** 0-30. */
    leadDays?: number;
    /** Refused without a fixed `amountMinor`: there would be nothing to post. */
    autoPost?: boolean;
    /** Empty under `Equal` means everyone in the guild, resolved at post time. */
    shares?: RecurringExpenseShareDto[];
}

/**
 * A partial patch. Only the keys present are written - which is why turning a fixed bill into a
 * varying one is {@link clearAmount} rather than `amountMinor: null`: null already means "leave it
 * alone", exactly as it does on the pantry patch.
 */
export interface UpdateRecurringExpenseDto {
    description?: string;
    amountMinor?: number;
    /** Makes the bill's amount vary from now on. Wins over `amountMinor` if both are sent. */
    clearAmount?: boolean;
    payerUserId?: string;
    splitKind?: ExpenseSplitKind;
    category?: ExpenseCategory;
    recurrenceUnit?: RecurrenceUnit;
    recurrenceInterval?: number;
    anchorAt?: string;
    leadDays?: number;
    autoPost?: boolean;
    isPaused?: boolean;
    /** Absent leaves the split alone; an **empty array** resets it to everyone in the guild. */
    shares?: RecurringExpenseShareDto[];
}

/**
 * Turns one period into a real expense.
 *
 * <p>`amountMinor` is required for a varying bill and optional for a fixed one, where sending it
 * overrides the template for this period only - which is what happens when the landlord puts the
 * rent up and nobody has updated the schedule yet.</p>
 */
export interface PostBillDto {
    amountMinor?: number;
    /**
     * Omitted defaults to the **due date**, not to now, so a bill posted three days late still
     * lands in the month it belongs to.
     */
    occurredAt?: string;
}

/** Waives one period. The reason is optional and worth asking for - a month with no rent gets queried. */
export interface SkipBillDto {
    reason?: string;
}
