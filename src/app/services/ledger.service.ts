import {inject, Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {Expense, ExpenseCategory, LedgerConfig, Settlement} from '../dtos/response/ledger.dto';
import {ExpenseReceipt} from '../dtos/response/ledger-insight.dto';
import {
    CreateExpenseDto,
    RecordSettlementDto,
    UpdateExpenseDto,
    UpdateLedgerConfigDto,
} from '../dtos/request/ledger.dto';
import {LedgerChannelState, LedgerStore, LedgerSummaryState} from '../stores/ledger.store';

export type {LedgerChannelState, LedgerSummaryState};

/** The view-facing shape of {@link LedgerStore}. State and realtime both live in the store. */
@Injectable({providedIn: 'root'})
export class LedgerService {
    private store = inject(LedgerStore);

    // ── Reads ────────────────────────────────────────────────────────────────

    stateFor(channelId: string): LedgerChannelState {
        return this.store.stateFor(channelId)();
    }

    /** The currency to format this channel's amounts in. */
    currencyFor(channelId: string): string {
        return this.store.currencyFor(channelId);
    }

    /** How many receipts an expense is known to have. `0` also covers "nobody has looked yet". */
    receiptCountFor(expenseId: string): number {
        return this.store.receiptCountFor(expenseId);
    }

    summaryFor(channelId: string): LedgerSummaryState {
        return this.store.summaryFor(channelId);
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    /** Idempotent per channel for the session; call it on every open. */
    loadFor(channelId: string): void {
        this.store.loadFor(channelId);
    }

    refresh(channelId: string): void {
        this.store.refresh(channelId);
    }

    /** Appends the next page of expenses. A no-op at the end of the ledger or while one is in the air. */
    loadMore(channelId: string): void {
        this.store.loadMore(channelId);
    }

    /** Narrows the expense list to one category, or to everything with `null`. Re-reads from page one. */
    setCategory(channelId: string, category: ExpenseCategory | null): void {
        this.store.setCategory(channelId, category);
    }

    /** Loads the spending rollup for the last `months` months. Never served from a different window. */
    loadSummary(channelId: string, months: number): void {
        this.store.loadSummary(channelId, months);
    }

    // ── Receipts ─────────────────────────────────────────────────────────────

    /** The receipts on one expense, freshly presigned. Uncached; only the count is kept. */
    listReceipts(expenseId: string): Observable<ExpenseReceipt[]> {
        return this.store.listReceipts(expenseId);
    }

    uploadReceipt(expenseId: string, file: File): Observable<ExpenseReceipt> {
        return this.store.uploadReceipt(expenseId, file);
    }

    removeReceipt(expenseId: string, receiptId: string): Observable<void> {
        return this.store.removeReceipt(expenseId, receiptId);
    }

    /** Re-reads balances and the settle-up plan together; the plan is derived from the balances. */
    refreshBalances(channelId: string): void {
        this.store.refreshBalances(channelId);
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    addExpense(channelId: string, body: CreateExpenseDto): Observable<Expense> {
        return this.store.addExpense(channelId, body);
    }

    editExpense(channelId: string, expenseId: string, body: UpdateExpenseDto): Observable<Expense> {
        return this.store.editExpense(channelId, expenseId, body);
    }

    removeExpense(channelId: string, expenseId: string): Observable<void> {
        return this.store.removeExpense(channelId, expenseId);
    }

    /** Records that a payment happened. Nothing moves; the balances just stop saying it is owed. */
    recordSettlement(channelId: string, body: RecordSettlementDto): Observable<Settlement> {
        return this.store.recordSettlement(channelId, body);
    }

    /** Relabelling only: every stored `amountMinor` keeps its digits. Callers must have said so first. */
    saveConfig(channelId: string, body: UpdateLedgerConfigDto): Observable<LedgerConfig> {
        return this.store.saveConfig(channelId, body);
    }
}
