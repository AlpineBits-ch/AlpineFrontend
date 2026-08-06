/**
 * The shared-expense ledger: expenses, how they split, what everyone is owed, and settlements.
 *
 * <p>Every amount here is `amountMinor` - a whole number of rappen/cents in the channel's currency.
 * There is no decimal money anywhere in the contract, on the wire or in this file, and there must
 * not be any in the client either: see `src/app/helpers/money.helper.ts` for why moving the decimal
 * point is a string operation and not a division.</p>
 */

/** How an expense is divided. Also the wire values - the server serializes the names. */
export enum ExpenseSplitKind {
    /** `shareValue` is ignored. An **empty `shares` array means everyone in the guild.** */
    Equal = 'Equal',
    /** `shareValue` is a weight: "Anna counts double, she has the big room". */
    Shares = 'Shares',
    /** `shareValue` is that person's exact `amountMinor`, and they must sum to the total. */
    Exact = 'Exact',
}

/**
 * Declaration order of the server's `ExpenseSplitKind`, for the case the payload carries an int.
 *
 * <p>The AsyncAPI schema for every expense event notes the enum is "int when serialised by a host
 * without JsonStringEnumConverter (see the gateway)" - so the same field is `"Equal"` down one path
 * and `0` down another. {@link normalizeExpense} collapses the two.</p>
 */
const SPLIT_KIND_BY_ORDINAL: readonly ExpenseSplitKind[] = [
    ExpenseSplitKind.Equal, ExpenseSplitKind.Shares, ExpenseSplitKind.Exact,
];

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
    /** Who entered it - **often not the payer**, and worth showing when the two differ. */
    createdByUserId: string;
    /**
     * The resolved split, as computed by the server. Under `Equal` the request may send this empty
     * to mean "everyone"; what comes back is always the expanded per-person list, remainders and
     * all - 1000 across three is 334/333/333, decided server-side and never re-derived here.
     */
    shares: ExpenseShare[];
}

/**
 * One page of expenses, newest first.
 *
 * <p>`GET /expenses` used to answer a bare array capped at a hard `Take(200)` with no way to ask
 * for more, so a ledger past its two-hundredth expense was silently truncated. It is now a cursor
 * page: `limit` defaults to 50 and caps at 200, and `nextCursor` goes back as `cursor`.</p>
 *
 * <p><b>`nextCursor: null` is the end of the ledger</b>, and it is the only thing that means that.
 * A short page does not - the server is free to return fewer rows than asked for and still have
 * more behind them.</p>
 */
export interface ExpensePage {
    items: Expense[];
    nextCursor: string | null;
}

/**
 * One member's net position. `+` means the house owes them; `-` means they owe the house.
 *
 * <p>Balances always sum to exactly zero, and **members at zero are omitted** - an empty array is
 * not "no data", it is "the house is settled".</p>
 */
export interface LedgerBalance {
    userId: string;
    netMinor: number;
}

/**
 * One payment that would move the house towards settled.
 *
 * <p>`settle-suggestion` returns at most n-1 of these: four flatmates settle with two payments, not
 * six. They are a plan, not a record - nothing has happened until a settlement is posted.</p>
 */
export interface TransferSuggestion {
    fromUserId: string;
    toUserId: string;
    amountMinor: number;
}

/**
 * A recorded payment between two members.
 *
 * <p>Field names taken from `components.messages.guild_SettlementRecorded` in the AsyncAPI document
 * (`SettlementDto`); the written guide describes settlements but never names their fields. Note
 * there is no `channelId` on the row itself - the realtime envelope carries it.</p>
 */
export interface Settlement {
    id: string;
    fromUserId: string;
    toUserId: string;
    amountMinor: number;
    settledAt: string;
    /** Who entered it. A third-party settlement is one where this is neither party. */
    recordedByUserId: string;
}

/** One currency per ledger channel. Changing it **relabels; it does not convert**. */
export interface LedgerConfig {
    channelId: string;
    /** ISO-4217, e.g. `"CHF"`. */
    currency: string;
}

// Request bodies live in `src/app/dtos/request/ledger.dto.ts`, in common with the other household
// modules - and because what the client may *say* about a split is narrower than what the server
// reports back.

// ── Realtime (server → client) ──────────────────────────────────────────────
//
// Shapes are the payload schemas of `guild_ExpenseCreated`, `guild_ExpenseUpdated`,
// `guild_ExpenseDeleted` and `guild_SettlementRecorded`. All four are broadcast to everyone
// present in the guild, and all four invalidate balances - which are re-fetched, never recomputed
// from the expense list on screen, because that list is a page of one channel and the balance is a
// fact about the whole ledger.

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

/**
 * Makes one expense safe to hold: the split kind is a name whichever way it arrived, and the
 * amounts are integers.
 *
 * <p>The int-vs-name enum is the gateway's, and it is invisible until the day a `@switch` on
 * `splitKind` silently stops matching. The `Math.trunc` is belt and braces: a `12.34` arriving in
 * `amountMinor` is a server bug, but a truncated one is at least still an integer and will not
 * poison a sum.</p>
 */
export function normalizeExpense(raw: Expense): Expense {
    return {
        ...raw,
        splitKind: normalizeSplitKind(raw.splitKind),
        amountMinor: Math.trunc(raw.amountMinor ?? 0),
        shares: (raw.shares ?? []).map(share => ({
            ...share,
            amountMinor: Math.trunc(share.amountMinor ?? 0),
        })),
    };
}

export function normalizeSplitKind(value: ExpenseSplitKind | number | string | null | undefined): ExpenseSplitKind {
    if (typeof value === 'number') return SPLIT_KIND_BY_ORDINAL[value] ?? ExpenseSplitKind.Equal;
    // A name the enum does not carry means a newer server; Equal is the reading that renders
    // something sane rather than an empty row.
    return (SPLIT_KIND_BY_ORDINAL as readonly string[]).includes(value as string)
        ? value as ExpenseSplitKind
        : ExpenseSplitKind.Equal;
}
