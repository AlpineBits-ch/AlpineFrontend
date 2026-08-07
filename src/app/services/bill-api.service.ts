import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {BillOccurrence, BillStatus, RecurringExpense} from '../dtos/response/bill.dto';
import {Expense} from '../dtos/response/ledger.dto';
import {
    CreateRecurringExpenseDto,
    PostBillDto,
    SkipBillDto,
    UpdateRecurringExpenseDto,
} from '../dtos/request/bill.dto';

/**
 * The bills HTTP surface, and nothing else.
 *
 * <p>Same two path shapes as the ledger next door: the collections hang off the channel, the
 * mutations off the row's own id. State and realtime reconciliation live in
 * {@link import('./bill.service').BillService}.</p>
 *
 * <p>Note {@link listBills} is not paged. A ledger's bills are one row per schedule per period, so a
 * house three years in with a dozen standing orders is a few hundred rows; the expense list next
 * door is the unbounded one and pages for exactly that reason.</p>
 */
@Injectable({providedIn: 'root'})
export class BillApiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    // ── Schedules ────────────────────────────────────────────────────────────

    listSchedules(channelId: string): Observable<RecurringExpense[]> {
        return this.http.get<RecurringExpense[]>(`${this.base}/channels/${channelId}/recurring-expenses`);
    }

    /** `ManageLedger`. A schedule is a standing arrangement, not a one-off anybody may add. */
    createSchedule(channelId: string, body: CreateRecurringExpenseDto): Observable<RecurringExpense> {
        return this.http.post<RecurringExpense>(`${this.base}/channels/${channelId}/recurring-expenses`, body);
    }

    /**
     * Edits a schedule. `ManageLedger`.
     *
     * <p>Editing <b>moves</b> the pending bills rather than regenerating them, so an amount somebody
     * typed off a paper letter survives a change to the cadence. Callers do not have to warn about
     * losing it, and must not imply that they might.</p>
     */
    updateSchedule(templateId: string, body: UpdateRecurringExpenseDto): Observable<RecurringExpense> {
        return this.http.patch<RecurringExpense>(`${this.base}/recurring-expenses/${templateId}`, body);
    }

    /** Deletes the schedule and every period it has not yet produced. Already-posted expenses stay. */
    deleteSchedule(templateId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/recurring-expenses/${templateId}`);
    }

    // ── Occurrences ──────────────────────────────────────────────────────────

    /**
     * The channel's bills, soonest first.
     *
     * <p>Bounded at 500 rather than paged - see the class doc. `status` narrows to one of
     * {@link BillStatus}; omitting it returns every period including the history.</p>
     */
    listBills(
        channelId: string,
        options: {status?: BillStatus | null; from?: string | null; to?: string | null} = {},
    ): Observable<BillOccurrence[]> {
        let params = new HttpParams();
        if (options.status) params = params.set('status', options.status);
        if (options.from) params = params.set('from', options.from);
        if (options.to) params = params.set('to', options.to);
        return this.http.get<BillOccurrence[]>(`${this.base}/channels/${channelId}/bills`, {params});
    }

    /**
     * Turns one period into a real expense, and answers with it.
     *
     * <p>`ManageLedger`, or `AddExpenses` when the caller is the payer - confirming what you
     * yourself just paid the landlord is the ordinary case, and needing a moderator for it would
     * mean the one person who knows the figure cannot enter it.</p>
     *
     * <p><b>A varying bill cannot be posted without an amount.</b> Send one, or the server answers
     * `400` - which is why the caller asks for a figure rather than offering a bare button.</p>
     */
    postBill(billId: string, body: PostBillDto = {}): Observable<Expense> {
        return this.http.post<Expense>(`${this.base}/bills/${billId}/post`, body);
    }

    /** Waives one period without touching the schedule. `ManageLedger`. */
    skipBill(billId: string, body: SkipBillDto = {}): Observable<BillOccurrence> {
        return this.http.post<BillOccurrence>(`${this.base}/bills/${billId}/skip`, body);
    }
}
