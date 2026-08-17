import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {
    Expense,
    ExpenseCategory,
    ExpensePage,
    LedgerBalance,
    LedgerConfig,
    Settlement,
    TransferSuggestion,
} from '../dtos/response/ledger.dto';
import {
    ExpenseReceipt,
    LedgerSummary,
    LedgerSummaryGroupBy,
} from '../dtos/response/ledger-insight.dto';
import {
    CreateExpenseDto,
    RecordSettlementDto,
    UpdateExpenseDto,
    UpdateLedgerConfigDto,
} from '../dtos/request/ledger.dto';

/** Rows per page, matching the server's own default. */
export const EXPENSE_PAGE_SIZE = 50;

/**
 * The ledger HTTP surface and nothing else; state and reconciliation live in `LedgerService`.
 * Reads and creates hang off the channel, edits and deletes off the expense. The doubled `guild` segment is correct: the gateway strips one before forwarding.
 */
@Injectable({providedIn: 'root'})
export class LedgerApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    // ── Expenses ─────────────────────────────────────────────────────────────

    /**
     * One page of the channel's expenses, newest first. Amounts are minor units; shares come back expanded.
     * A cursor the server cannot parse is a `400`, never a silent rewind, so a stale one must not be retried as if it were empty.
     */
    listExpenses(
        channelId: string,
        limit = EXPENSE_PAGE_SIZE,
        cursor?: string | null,
        category?: ExpenseCategory | null,
    ): Observable<ExpensePage> {
        let params = new HttpParams().set('limit', limit);
        if (cursor) params = params.set('cursor', cursor);
        // Applied server-side: a client-side filter would silently narrow only the loaded page.
        if (category) params = params.set('category', category);
        return this.http.get<ExpensePage>(`${this.base}/channels/${channelId}/expenses`, {params});
    }

    /** Adds one expense. `AddExpenses` for your own, `ManageLedger` to name another payer; the split is described, never resolved here. */
    createExpense(channelId: string, body: CreateExpenseDto): Observable<Expense> {
        return this.http.post<Expense>(`${this.base}/channels/${channelId}/expenses`, body);
    }

    /** Editing your own needs `AddExpenses`; editing anyone else's needs `ManageLedger`. */
    updateExpense(expenseId: string, body: UpdateExpenseDto): Observable<Expense> {
        return this.http.patch<Expense>(`${this.base}/expenses/${expenseId}`, body);
    }

    deleteExpense(expenseId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/expenses/${expenseId}`);
    }

    // ── Balances and settling ────────────────────────────────────────────────

    /** Net position per member, positive meaning the house owes them. Members at zero are omitted, so an empty array is a settled house; a balance is never recomputed from the expense list. */
    balances(channelId: string): Observable<LedgerBalance[]> {
        return this.http.get<LedgerBalance[]>(`${this.base}/channels/${channelId}/ledger/balances`);
    }

    /** At most n-1 transfers that clear the board. A plan; nothing is recorded by asking for it. */
    settleSuggestion(channelId: string): Observable<TransferSuggestion[]> {
        return this.http.get<TransferSuggestion[]>(`${this.base}/channels/${channelId}/ledger/settle-suggestion`);
    }

    /** Records that someone paid someone else; it moves no money. Your own needs `AddExpenses`, one between two other people needs `ManageLedger`. */
    recordSettlement(channelId: string, body: RecordSettlementDto): Observable<Settlement> {
        return this.http.post<Settlement>(`${this.base}/channels/${channelId}/ledger/settlements`, body);
    }

    // ── Config ───────────────────────────────────────────────────────────────

    getConfig(channelId: string): Observable<LedgerConfig> {
        return this.http.get<LedgerConfig>(`${this.base}/channels/${channelId}/ledger/config`);
    }

    /** Changing `currency` relabels every existing amount. It converts nothing. */
    updateConfig(channelId: string, body: UpdateLedgerConfigDto): Observable<LedgerConfig> {
        return this.http.put<LedgerConfig>(`${this.base}/channels/${channelId}/ledger/config`, body);
    }

    // ── Receipts ─────────────────────────────────────────────────────────────

    /** The receipts on one expense, each with a freshly minted URL. Call on every open and never cache the result: presigned URLs expire and then 403 forever. */
    listReceipts(expenseId: string): Observable<ExpenseReceipt[]> {
        return this.http.get<ExpenseReceipt[]>(`${this.base}/expenses/${expenseId}/receipts`);
    }

    /** Uploads one receipt. Multipart with the field named `file`, singular, not the `files` collection the attachment endpoint takes. */
    uploadReceipt(expenseId: string, file: File): Observable<ExpenseReceipt> {
        const form = new FormData();
        form.append('file', file, file.name);
        // No explicit Content-Type: naming the header strips the multipart boundary the browser sets.
        return this.http.post<ExpenseReceipt>(`${this.base}/expenses/${expenseId}/receipts`, form);
    }

    deleteReceipt(receiptId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/receipts/${receiptId}`);
    }

    // ── The spending rollup ──────────────────────────────────────────────────

    /** What the house spent over a window. Omitting `from`/`to` asks for the default six months; the window caps at three years. */
    summary(
        channelId: string,
        options: {from?: string | null; to?: string | null; groupBy?: LedgerSummaryGroupBy | null} = {},
    ): Observable<LedgerSummary> {
        let params = new HttpParams();
        if (options.from) params = params.set('from', options.from);
        if (options.to) params = params.set('to', options.to);
        if (options.groupBy) params = params.set('groupBy', options.groupBy);
        return this.http.get<LedgerSummary>(`${this.base}/channels/${channelId}/ledger/summary`, {params});
    }
}
