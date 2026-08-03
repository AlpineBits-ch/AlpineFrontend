import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {
    Expense,
    LedgerBalance,
    LedgerConfig,
    Settlement,
    TransferSuggestion,
} from '../dtos/response/ledger.dto';
import {
    CreateExpenseDto,
    RecordSettlementDto,
    UpdateExpenseDto,
    UpdateLedgerConfigDto,
} from '../dtos/request/ledger.dto';

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

    /** Every expense in the channel. Amounts are minor units; the shares come back expanded. */
    listExpenses(channelId: string): Observable<Expense[]> {
        return this.http.get<Expense[]>(`${this.base}/channels/${channelId}/expenses`);
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
}
