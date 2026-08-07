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

/**
 * Rows per page. The server's own default, and comfortably more than a screen - a household ledger
 * is read in months, so the first page is almost always the whole conversation.
 */
export const EXPENSE_PAGE_SIZE = 50;

/**
 * The ledger HTTP surface, and nothing else.
 *
 * <p>Two path shapes, and they are not interchangeable. Reads and creates hang off the channel
 * (`/channels/{channelId}/expenses`) because a ledger belongs to one channel; edits and deletes
 * hang off the expense (`/expenses/{expenseId}`) because an id already says which channel it is
 * in. The doubled `guild` segment is correct - the gateway strips one before forwarding.</p>
 *
 * <p>State, realtime reconciliation and the "re-fetch balances after every mutation" rule all live
 * in {@link import('./ledger.service').LedgerService}; nothing here remembers anything.</p>
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
     * One page of the channel's expenses, newest first. Amounts are minor units; shares come back
     * expanded.
     *
     * <p>Paged, not a bare array - reading `response.length` gets `undefined` and rendering an
     * empty ledger. `limit` caps at 200 server-side; `cursor` is {@link ExpensePage.nextCursor}
     * from the previous page and nothing else. A cursor the server cannot parse is a `400`, not a
     * silent rewind to the first page, so a stale one must never be retried as if it were empty.</p>
     */
    listExpenses(
        channelId: string,
        limit = EXPENSE_PAGE_SIZE,
        cursor?: string | null,
        category?: ExpenseCategory | null,
    ): Observable<ExpensePage> {
        let params = new HttpParams().set('limit', limit);
        if (cursor) params = params.set('cursor', cursor);
        // Applied server-side rather than by filtering a loaded page: the filter has to reach past
        // what is on screen, and a client-side one would silently narrow the first fifty rows and
        // call the result "all the groceries".
        if (category) params = params.set('category', category);
        return this.http.get<ExpensePage>(`${this.base}/channels/${channelId}/expenses`, {params});
    }

    /**
     * Adds one expense.
     *
     * <p>`AddExpenses` covers adding one you paid yourself; naming someone else as `payerUserId`
     * needs `ManageLedger`. The split is described, never resolved: send `Equal` (with empty
     * `shares` for the whole guild) or `Shares`, and let the server decide who eats the remainder.</p>
     */
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

    /**
     * Net position per member, positive meaning the house owes them.
     *
     * <p>Always sums to zero, and members at zero are omitted - so an empty array is the settled
     * house, not a failed request. This is the only source of a balance: it is never recomputed
     * from the expense list, which would need every expense ever written to be on screen.</p>
     */
    balances(channelId: string): Observable<LedgerBalance[]> {
        return this.http.get<LedgerBalance[]>(`${this.base}/channels/${channelId}/ledger/balances`);
    }

    /** At most n-1 transfers that clear the board. A plan; nothing is recorded by asking for it. */
    settleSuggestion(channelId: string): Observable<TransferSuggestion[]> {
        return this.http.get<TransferSuggestion[]>(`${this.base}/channels/${channelId}/ledger/settle-suggestion`);
    }

    /**
     * Records that someone paid someone else. It does not move money - there is no money here to
     * move - it just tells the ledger the debt was cleared outside it.
     *
     * <p>Your own needs `AddExpenses`; recording one between two other people needs
     * `ManageLedger`.</p>
     */
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

    /**
     * The receipts on one expense, each with a freshly minted URL.
     *
     * <p><b>Call this every time the gallery opens and never cache what comes back.</b> The URLs are
     * presigned per request and carry an expiry: a stored one renders for a few minutes after upload
     * and then 403s forever, which looks exactly like a lost file.</p>
     */
    listReceipts(expenseId: string): Observable<ExpenseReceipt[]> {
        return this.http.get<ExpenseReceipt[]>(`${this.base}/expenses/${expenseId}/receipts`);
    }

    /**
     * Uploads one receipt. `AddExpenses` on your own expense, `ManageLedger` on anyone else's.
     *
     * <p>Multipart with the field named `file`, singular - not the `files` collection the message
     * attachment endpoint takes, and not interchangeable with it. Max four per expense, images and
     * PDF only.</p>
     */
    uploadReceipt(expenseId: string, file: File): Observable<ExpenseReceipt> {
        const form = new FormData();
        form.append('file', file, file.name);
        // No explicit Content-Type: the browser has to set the multipart boundary itself, and
        // naming the header strips it and produces an unparseable body.
        return this.http.post<ExpenseReceipt>(`${this.base}/expenses/${expenseId}/receipts`, form);
    }

    deleteReceipt(receiptId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/receipts/${receiptId}`);
    }

    // ── The spending rollup ──────────────────────────────────────────────────

    /**
     * What the house spent over a window. `ViewChannel`.
     *
     * <p>Omitting `from`/`to` asks for the server's default six months; the window is capped at
     * three years and the response says so when it was shortened. `groupBy` narrows the answer to
     * one breakdown, which is worth doing only when the other one is not on screen.</p>
     */
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
