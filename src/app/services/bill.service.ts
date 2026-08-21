import {inject, Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {BillOccurrence, RecurringExpense} from '../dtos/response/bill.dto';
import {Expense} from '../dtos/response/ledger.dto';
import {
    CreateRecurringExpenseDto,
    PostBillDto,
    SkipBillDto,
    UpdateRecurringExpenseDto,
} from '../dtos/request/bill.dto';
import {BillChannelState, BillStore} from '../stores/bill.store';

export type {BillChannelState};

/** The view-facing shape of {@link BillStore}. State and realtime both live in the store. */
@Injectable({providedIn: 'root'})
export class BillService {
    private store = inject(BillStore);

    // ── Reads ────────────────────────────────────────────────────────────────

    stateFor(channelId: string): BillChannelState {
        return this.store.stateFor(channelId)();
    }

    /** Still owed, soonest first. What the upcoming board draws, and never ledger history. */
    upcomingFor(channelId: string): BillOccurrence[] {
        return this.store.upcomingFor(channelId)();
    }

    scheduleFor(channelId: string, templateId: string): RecurringExpense | null {
        return this.store.scheduleFor(channelId, templateId);
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    /** Idempotent per channel for the session; call it on every open. */
    loadFor(channelId: string): void {
        this.store.loadFor(channelId);
    }

    refresh(channelId: string): void {
        this.store.refresh(channelId);
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    addSchedule(channelId: string, body: CreateRecurringExpenseDto): Observable<RecurringExpense> {
        return this.store.addSchedule(channelId, body);
    }

    editSchedule(
        channelId: string,
        templateId: string,
        body: UpdateRecurringExpenseDto,
    ): Observable<RecurringExpense> {
        return this.store.editSchedule(channelId, templateId, body);
    }

    removeSchedule(channelId: string, templateId: string): Observable<void> {
        return this.store.removeSchedule(channelId, templateId);
    }

    /** Turns one bill into a real expense, and invalidates the ledger balances it just changed. */
    postBill(channelId: string, billId: string, body: PostBillDto = {}): Observable<Expense> {
        return this.store.postBill(channelId, billId, body);
    }

    skipBill(channelId: string, billId: string, body: SkipBillDto = {}): Observable<BillOccurrence> {
        return this.store.skipBill(channelId, billId, body);
    }
}
