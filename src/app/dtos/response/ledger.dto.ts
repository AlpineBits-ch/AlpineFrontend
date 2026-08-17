/**
 * The shared-expense ledger: expenses, how they split, what everyone is owed, and settlements.
 * Every amount is `amountMinor`, a whole number of minor units. No decimal money anywhere.
 */

/** How an expense is divided. Also the wire values; the server serializes the names. */
export enum ExpenseSplitKind {
    /** `shareValue` is ignored. An empty `shares` array means everyone in the guild. */
    Equal = 'Equal',
    /** `shareValue` is a weight: "Anna counts double, she has the big room". */
    Shares = 'Shares',
    /** `shareValue` is that person's exact `amountMinor`, and they must sum to the total. */
    Exact = 'Exact',
}

/** Declaration order of the server's `ExpenseSplitKind`, for the case the payload carries an int. */
const SPLIT_KIND_BY_ORDINAL: readonly ExpenseSplitKind[] = [
    ExpenseSplitKind.Equal, ExpenseSplitKind.Shares, ExpenseSplitKind.Exact,
];

/** What an expense was for. `Uncategorized` is the zero value and is not `Other`; keep them apart. */
export enum ExpenseCategory {
    Uncategorized = 'Uncategorized',
    Groceries = 'Groceries',
    Rent = 'Rent',
    Utilities = 'Utilities',
    Internet = 'Internet',
    Household = 'Household',
    Transport = 'Transport',
    EatingOut = 'EatingOut',
    Entertainment = 'Entertainment',
    Health = 'Health',
    Pets = 'Pets',
    Repairs = 'Repairs',
    Other = 'Other',
}

/** Declaration order of the server's enum, for the case the payload carries an int. */
const CATEGORY_BY_ORDINAL: readonly ExpenseCategory[] = [
    ExpenseCategory.Uncategorized, ExpenseCategory.Groceries, ExpenseCategory.Rent,
    ExpenseCategory.Utilities, ExpenseCategory.Internet, ExpenseCategory.Household,
    ExpenseCategory.Transport, ExpenseCategory.EatingOut, ExpenseCategory.Entertainment,
    ExpenseCategory.Health, ExpenseCategory.Pets, ExpenseCategory.Repairs, ExpenseCategory.Other,
];

/** Every category, in the declaration order the picker offers them. */
export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = CATEGORY_BY_ORDINAL;

/** `EatingOut` -> `LEDGER.CATEGORY.EATING_OUT`. One rule, so a new category needs one string. */
export function expenseCategoryLabelKey(category: ExpenseCategory): string {
    const snake = category.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    return `LEDGER.CATEGORY.${snake}`;
}

/** The category name whichever way it arrived, defaulting to `Uncategorized`. */
export function normalizeExpenseCategory(
    value: ExpenseCategory | number | string | null | undefined,
): ExpenseCategory {
    if (typeof value === 'number') return CATEGORY_BY_ORDINAL[value] ?? ExpenseCategory.Uncategorized;
    return (CATEGORY_BY_ORDINAL as readonly string[]).includes(value as string)
        ? value as ExpenseCategory
        : ExpenseCategory.Uncategorized;
}

export interface ExpenseShare {
    userId: string;
    /** A weight under `Shares`, that person's own `amountMinor` under `Exact`, ignored under `Equal`. */
    shareValue: number;
    /** What this person actually owes for this expense, computed server-side. Always integer. */
    amountMinor: number;
}

export interface Expense {
    id: string;
    channelId: string;
    /** Who actually paid the shop. */
    payerUserId: string;
    description: string;
    /** Whole minor units. Never a decimal, in either direction. */
    amountMinor: number;
    /** ISO-4217, copied from the channel's ledger config at write time. */
    currency: string;
    occurredAt: string;
    splitKind: ExpenseSplitKind;
    /** Who entered it, often not the payer. Worth showing when the two differ. */
    createdByUserId: string;
    /** The resolved split, computed server-side. Always the expanded per-person list; never re-derive it. */
    shares: ExpenseShare[];
    /** What it was for. Absent reads as {@link ExpenseCategory.Uncategorized}. */
    category?: ExpenseCategory;
}

/**
 * One page of expenses, newest first. `nextCursor: null` is the only end-of-ledger signal; a short
 * page is not one.
 */
export interface ExpensePage {
    items: Expense[];
    nextCursor: string | null;
}

/**
 * One member's net position. Positive means the house owes them. Balances sum to zero and members
 * at zero are omitted, so an empty array means settled, not "no data".
 */
export interface LedgerBalance {
    userId: string;
    netMinor: number;
}

/** One payment that would move the house towards settled. A plan, not a record. */
export interface TransferSuggestion {
    fromUserId: string;
    toUserId: string;
    amountMinor: number;
}

/** A recorded payment between two members. No `channelId` on the row; the realtime envelope carries it. */
export interface Settlement {
    id: string;
    fromUserId: string;
    toUserId: string;
    amountMinor: number;
    settledAt: string;
    /** Who entered it. A third-party settlement is one where this is neither party. */
    recordedByUserId: string;
}

/** One currency per ledger channel. Changing it relabels; it does not convert. */
export interface LedgerConfig {
    channelId: string;
    /** ISO-4217, e.g. `"CHF"`. */
    currency: string;
}

// Request bodies live in `src/app/dtos/request/ledger.dto.ts`.

// ── Realtime (server → client) ──────────────────────────────────────────────
//
// All four invalidate balances, which are re-fetched and never recomputed from the expense list.

export interface ExpenseCreated {
    guildId: string;
    channelId: string;
    expense: Expense;
}

export interface ExpenseUpdated {
    guildId: string;
    channelId: string;
    expense: Expense;
}

export interface ExpenseDeleted {
    guildId: string;
    channelId: string;
    expenseId: string;
}

export interface SettlementRecorded {
    guildId: string;
    channelId: string;
    settlement: Settlement;
}

// ── Normalization ───────────────────────────────────────────────────────────

/** Makes one expense safe to hold: the split kind is a name whichever way it arrived, amounts are integers. */
export function normalizeExpense(raw: Expense): Expense {
    return {
        ...raw,
        splitKind: normalizeSplitKind(raw.splitKind),
        category: normalizeExpenseCategory(raw.category),
        amountMinor: Math.trunc(raw.amountMinor ?? 0),
        shares: (raw.shares ?? []).map(share => ({
            ...share,
            amountMinor: Math.trunc(share.amountMinor ?? 0),
        })),
    };
}

export function normalizeSplitKind(value: ExpenseSplitKind | number | string | null | undefined): ExpenseSplitKind {
    if (typeof value === 'number') return SPLIT_KIND_BY_ORDINAL[value] ?? ExpenseSplitKind.Equal;
    // A name the enum does not carry means a newer server; fall back to Equal.
    return (SPLIT_KIND_BY_ORDINAL as readonly string[]).includes(value as string)
        ? value as ExpenseSplitKind
        : ExpenseSplitKind.Equal;
}
