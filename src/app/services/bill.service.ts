import {inject, Injectable, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {forkJoin, Observable, of, tap} from 'rxjs';
import {catchError} from 'rxjs/operators';
import {
    BillOccurrence,
    BillOccurrenceCreated,
    BillOccurrenceUpdated,
    isBillOutstanding,
    normalizeBill,
    normalizeRecurringExpense,
    RecurringExpense,
    RecurringExpenseCreated,
    RecurringExpenseDeleted,
    RecurringExpenseUpdated,
} from '../dtos/response/bill.dto';
import {Expense} from '../dtos/response/ledger.dto';
import {
    CreateRecurringExpenseDto,
    PostBillDto,
    SkipBillDto,
    UpdateRecurringExpenseDto,
} from '../dtos/request/bill.dto';
import {BillApiService} from './bill-api.service';
import {LedgerService} from './ledger.service';
import {RealtimeConnectionService} from './realtime-connection.service';

export interface BillChannelState {
    /** Every schedule in the channel, paused ones included - a paused bill is still an arrangement. */
    schedules: RecurringExpense[];
    /** Every period the server holds for this channel, soonest first. Bounded, not paged. */
    bills: BillOccurrence[];
    loading: boolean;
    loaded: boolean;
    /** A `403`. Which usually means the guild has no Ledger module - render nothing, not a denial. */
    forbidden: boolean;
    failed: boolean;
}

const EMPTY_STATE: BillChannelState = {
    schedules: [],
    bills: [],
    loading: false,
    loaded: false,
    forbidden: false,
    failed: false,
};

/**
 * Bills: the schedules a ledger channel holds and the periods they have generated.
 *
 * <p>Kept apart from {@link LedgerService} on purpose, and not because the endpoints are separate.
 * <b>A bill is an obligation before it is an expense.</b> Expenses are history - money that moved -
 * and balances are derived from them; a pending bill is money that has not moved, owed to a future
 * date, and nothing about it belongs in a balance. Holding the two in one cache is how "rent is due
 * Friday" ends up rendered as a line of ledger history that somebody then tries to settle.</p>
 *
 * <p>The one place they meet is {@link postBill}, which turns an obligation into history - and
 * therefore has to invalidate the ledger's balances, since a new expense has just appeared that
 * this service does not own.</p>
 */
@Injectable({providedIn: 'root'})
export class BillService {
    private api = inject(BillApiService);
    private ledger = inject(LedgerService);
    private realtime = inject(RealtimeConnectionService);

    private readonly states = signal<Record<string, BillChannelState>>({});

    /** Channels whose first load has been kicked off, so `loadFor` is free to call on every open. */
    private readonly requested = new Set<string>();

    constructor() {
        // Registered once, here, in a root singleton: `RealtimeConnectionService.on` does not
        // deduplicate, and a schedule applied twice is harmless while a bill list that grows a
        // duplicate row is somebody paying the rent twice.
        this.realtime.on('guild.RecurringExpenseCreated', (d: RecurringExpenseCreated) =>
            this.onScheduleUpserted(d),
        );
        this.realtime.on('guild.RecurringExpenseUpdated', (d: RecurringExpenseUpdated) =>
            this.onScheduleUpserted(d),
        );
        this.realtime.on('guild.RecurringExpenseDeleted', (d: RecurringExpenseDeleted) =>
            this.onScheduleDeleted(d),
        );
        this.realtime.on('guild.BillOccurrenceCreated', (d: BillOccurrenceCreated) => this.onBillUpserted(d));
        this.realtime.on('guild.BillOccurrenceUpdated', (d: BillOccurrenceUpdated) => this.onBillUpserted(d));
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    stateFor(channelId: string): BillChannelState {
        return this.states()[channelId] ?? EMPTY_STATE;
    }

    /** Still owed, soonest first. What the upcoming board draws, and never ledger history. */
    upcomingFor(channelId: string): BillOccurrence[] {
        return this.stateFor(channelId).bills.filter(isBillOutstanding);
    }

    scheduleFor(channelId: string, templateId: string): RecurringExpense | null {
        return this.stateFor(channelId).schedules.find(s => s.id === templateId) ?? null;
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    /** Idempotent per channel for the session; call it on every open. */
    loadFor(channelId: string): void {
        if (this.requested.has(channelId)) return;
        this.requested.add(channelId);
        this.refresh(channelId);
    }

    refresh(channelId: string): void {
        this.patch(channelId, state => ({...state, loading: true, failed: false}));

        forkJoin({
            // Folded to null rather than allowed to collapse the pair: a schedule list that 500s
            // must not also blank the bills that did arrive, and vice versa - the upcoming board is
            // the useful half and it does not need the templates to render.
            schedules: this.api
                .listSchedules(channelId)
                .pipe(catchError((err: unknown) => this.swallow<RecurringExpense[]>(channelId, err))),
            bills: this.api
                .listBills(channelId)
                .pipe(catchError((err: unknown) => this.swallow<BillOccurrence[]>(channelId, err))),
        }).subscribe(({schedules, bills}) => {
            this.patch(channelId, state => ({
                ...state,
                schedules: (schedules ?? []).map(normalizeRecurringExpense),
                bills: this.sorted((bills ?? []).map(normalizeBill)),
                loading: false,
                loaded: true,
                failed: !state.forbidden && schedules === null && bills === null,
            }));
        });
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    addSchedule(channelId: string, body: CreateRecurringExpenseDto): Observable<RecurringExpense> {
        return this.api
            .createSchedule(channelId, body)
            .pipe(tap(schedule => this.upsertSchedule(channelId, schedule)));
    }

    editSchedule(
        channelId: string,
        templateId: string,
        body: UpdateRecurringExpenseDto,
    ): Observable<RecurringExpense> {
        return this.api.updateSchedule(templateId, body).pipe(
            tap(schedule => {
                this.upsertSchedule(channelId, schedule);
                // The edit moved the pending periods rather than regenerating them, so their due dates
                // and descriptions have changed underneath what is on screen. The individual moves
                // arrive as BillOccurrenceUpdated, but a schedule whose interval shrank can also drop
                // periods, and there is no event for that - so re-read the board.
                this.refreshBills(channelId);
            }),
        );
    }

    removeSchedule(channelId: string, templateId: string): Observable<void> {
        return this.api.deleteSchedule(templateId).pipe(
            tap(() => {
                this.patchExisting(channelId, state => ({
                    ...state,
                    schedules: state.schedules.filter(s => s.id !== templateId),
                    // Pending periods go with the schedule. Posted ones are expenses now and stay.
                    bills: state.bills.filter(
                        b => b.recurringExpenseId !== templateId || !isBillOutstanding(b),
                    ),
                }));
            }),
        );
    }

    /**
     * Turns one bill into a real expense.
     *
     * <p>The bill's own row arrives as `guild.BillOccurrenceUpdated`, but the <b>expense</b> it
     * became is the ledger's, and nothing over there knows a bill was posted - so the balances are
     * invalidated from here. Without that the ledger says the house is settled while somebody has
     * just been charged 850.</p>
     */
    postBill(channelId: string, billId: string, body: PostBillDto = {}): Observable<Expense> {
        return this.api.postBill(billId, body).pipe(
            tap(() => {
                this.refreshBills(channelId);
                this.ledger.refresh(channelId);
            }),
        );
    }

    skipBill(channelId: string, billId: string, body: SkipBillDto = {}): Observable<BillOccurrence> {
        return this.api.skipBill(billId, body).pipe(tap(bill => this.upsertBill(channelId, bill)));
    }

    // ── Realtime ─────────────────────────────────────────────────────────────

    private onScheduleUpserted(event: RecurringExpenseCreated | RecurringExpenseUpdated): void {
        this.upsertSchedule(event.channelId, event.recurringExpense, true);
    }

    private onScheduleDeleted(event: RecurringExpenseDeleted): void {
        this.patchExisting(event.channelId, state => ({
            ...state,
            schedules: state.schedules.filter(s => s.id !== event.recurringExpenseId),
            bills: state.bills.filter(
                b => b.recurringExpenseId !== event.recurringExpenseId || !isBillOutstanding(b),
            ),
        }));
    }

    private onBillUpserted(event: BillOccurrenceCreated | BillOccurrenceUpdated): void {
        this.upsertBill(event.channelId, event.bill, true);
    }

    // ── State plumbing ───────────────────────────────────────────────────────

    private upsertSchedule(channelId: string, raw: RecurringExpense, existingOnly = false): void {
        const schedule = normalizeRecurringExpense(raw);
        const apply = (state: BillChannelState): BillChannelState => ({
            ...state,
            schedules: [...state.schedules.filter(s => s.id !== schedule.id), schedule].sort(
                (a, b) => a.nextDueAt.localeCompare(b.nextDueAt) || a.id.localeCompare(b.id),
            ),
        });
        if (existingOnly) this.patchExisting(channelId, apply);
        else this.patch(channelId, apply);
    }

    private upsertBill(channelId: string, raw: BillOccurrence, existingOnly = false): void {
        const bill = normalizeBill(raw);
        const apply = (state: BillChannelState): BillChannelState => ({
            ...state,
            bills: this.sorted([...state.bills.filter(b => b.id !== bill.id), bill]),
        });
        if (existingOnly) this.patchExisting(channelId, apply);
        else this.patch(channelId, apply);
    }

    /** Re-reads the periods only. The schedules are unchanged by anything that calls this. */
    private refreshBills(channelId: string): void {
        if (!this.states()[channelId]) return;
        this.api.listBills(channelId).subscribe({
            next: bills =>
                this.patchExisting(channelId, state => ({
                    ...state,
                    bills: this.sorted(bills.map(normalizeBill)),
                })),
            error: () => undefined,
        });
    }

    /**
     * Soonest first - the opposite of the expense list, and for the opposite reason.
     *
     * <p>The ledger answers "what happened", so it reads newest first. The bill board answers "what
     * is coming", and a board opened at the far end of the history would put the row that needs
     * paying this week below three years of rent.</p>
     */
    private sorted(bills: BillOccurrence[]): BillOccurrence[] {
        return [...bills].sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id));
    }

    private patch(channelId: string, fn: (state: BillChannelState) => BillChannelState): void {
        this.states.update(all => ({...all, [channelId]: fn(all[channelId] ?? EMPTY_STATE)}));
    }

    /** As {@link patch}, but silently drops events for channels nobody has opened. */
    private patchExisting(channelId: string, fn: (state: BillChannelState) => BillChannelState): void {
        this.states.update(all => (all[channelId] ? {...all, [channelId]: fn(all[channelId])} : all));
    }

    private swallow<T>(channelId: string, err: unknown): Observable<T | null> {
        if (err instanceof HttpErrorResponse && err.status === 403) {
            this.patch(channelId, state => ({...state, forbidden: true}));
        }
        return of(null);
    }
}
