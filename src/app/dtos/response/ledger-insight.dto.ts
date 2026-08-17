import {ExpenseCategory} from './ledger.dto';

/**
 * The two things the ledger grew that are *about* expenses rather than being ones: the receipt
 * photos hanging off an expense, and the rollup that answers "what does this flat cost per month".
 *
 * <p>Every amount here is whole minor units, as everywhere else in the money path. The buckets sum
 * back to {@link LedgerSummary.totalMinor} exactly, and they only keep doing so while nothing in
 * this client averages one into a decimal.</p>
 */

// ── Receipts ────────────────────────────────────────────────────────────────

/**
 * One receipt photo or PDF attached to an expense.
 *
 * <p><b>{@link url} must never be cached.</b> It is presigned and minted per request, so persisting
 * one persists its expiry: the first symptom is a receipt that renders for ten minutes after upload
 * and then 403s forever. Anything holding a receipt across time holds the {@link id} and re-lists.</p>
 */
export interface ExpenseReceipt {
    id: string;
    expenseId: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    uploadedByUserId: string;
    uploadedAt: string;
    /** Presigned, short-lived, and absent when the server could not mint one. See the type doc. */
    url?: string | null;
}

/** `MaxReceiptsPerExpense`. Mirrored so the picker closes rather than the upload 400ing. */
export const MAX_RECEIPTS_PER_EXPENSE = 4;

/**
 * What the server will store. Images and PDF only - it is a receipt, not an attachment field.
 *
 * <p>Used for the file input's `accept` and for a pre-flight check, because a rejected upload after
 * a 4 MB round trip on a phone is a worse answer than a greyed-out picker.</p>
 */
export const RECEIPT_ACCEPT = 'image/*,application/pdf';

export function isAcceptedReceiptType(contentType: string): boolean {
    return contentType.startsWith('image/') || contentType === 'application/pdf';
}

// ── The spending rollup ─────────────────────────────────────────────────────

export interface LedgerCategoryTotal {
    category: ExpenseCategory;
    totalMinor: number;
    /** The caller's share of this bucket - their half of the shop, not what they paid for. */
    myShareMinor: number;
    count: number;
}

export interface LedgerPeriodTotal {
    /** `"2026-07"`. A month, because that is the unit rent and every other comparison runs on. */
    period: string;
    totalMinor: number;
    myShareMinor: number;
    count: number;
}

/**
 * What one member fronted over the window.
 *
 * <p>Deliberately not a balance. It says who has been carrying the cash flow, which is a different
 * question from who owes whom and is not answerable from `/ledger/balances`.</p>
 */
export interface LedgerPayerTotal {
    userId: string;
    paidMinor: number;
}

/**
 * `GET /channels/{id}/ledger/summary` - what the house spent, and what of it was the caller's.
 *
 * <p><b>{@link byPeriod} is not zero-filled.</b> A month with no spending in it is simply absent,
 * so anything drawing a series off this has to skip the gap rather than plot a zero: a chart with
 * an invented 0.00 for August says the house spent nothing that month, which is a different claim
 * from "nobody wrote anything down".</p>
 */
export interface LedgerSummary {
    channelId: string;
    /** ISO-4217, the channel's. Two summaries are never added together. */
    currency: string;
    from: string;
    to: string;
    totalMinor: number;
    /** The caller's own share of everything in the window. The number people actually want. */
    myShareMinor: number;
    byCategory: LedgerCategoryTotal[];
    byPeriod: LedgerPeriodTotal[];
    byPayer: LedgerPayerTotal[];
    /**
     * The window asked for was longer than the three-year cap and was shortened.
     *
     * <p>Worth saying out loud: a total that quietly covers less than what was requested is a
     * number somebody will act on and be wrong about.</p>
     */
    clamped?: boolean;
}

/** What `groupBy` narrows the response to. Omitted asks for both breakdowns. */
export type LedgerSummaryGroupBy = 'month' | 'category';

/** The server's default window, mirrored so the picker opens on what it will actually get. */
export const SUMMARY_DEFAULT_MONTHS = 6;

/** The window options the rollup offers, in months. Three years is the server's cap. */
export const SUMMARY_WINDOWS: readonly number[] = [3, 6, 12, 36];

// ── Realtime (server → client) ──────────────────────────────────────────────

export interface ExpenseReceiptAdded {
    guildId: string;
    channelId: string;
    expenseId: string;
    receipt: ExpenseReceipt;
}

export interface ExpenseReceiptDeleted {
    guildId: string;
    channelId: string;
    expenseId: string;
    receiptId: string;
}
