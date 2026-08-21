import {computed, inject, Signal} from '@angular/core';
import {map, Observable, tap} from 'rxjs';
import {signalStore, withHooks, withMethods} from '@ngrx/signals';
import {withEntities} from '@ngrx/signals/entities';
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
import {BillApiService} from '../services/bill-api.service';
import {LedgerService} from '../services/ledger.service';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {withKeyedIndex} from './foundation/with-keyed-index';
import {LoadFailure} from './foundation/request-state';

export interface BillChannelState {
    /** Every schedule in the channel, paused ones included: a paused bill is still an arrangement. */
    schedules: RecurringExpense[];
    /** Every period the server holds for this channel, soonest first. Bounded, not paged. */
    bills: BillOccurrence[];
    loading: boolean;
    loaded: boolean;
    /** A `403`. Which usually means the guild has no Ledger module: render nothing, not a denial. */
    forbidden: boolean;
    failed: boolean;
}

function byNextDue(a: RecurringExpense, b: RecurringExpense): number {
    return a.nextDueAt.localeCompare(b.nextDueAt) || a.id.localeCompare(b.id);
}

/**
 * Soonest first, the opposite of the expense list and for the opposite reason. The ledger answers
 * "what happened" so it reads newest first; a board opened at the far end of the history would put
 * the row that needs paying this week below three years of rent.
 */
function byDueDate(a: BillOccurrence, b: BillOccurrence): number {
    return a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id);
}

function sameRows<T>(a: readonly T[], b: readonly T[]): boolean {
    return a.length === b.length && a.every((row, index) => row === b[index]);
}

function sameState(a: BillChannelState, b: BillChannelState): boolean {
    return (
        a.schedules === b.schedules &&
        a.bills === b.bills &&
        a.loading === b.loading &&
        a.loaded === b.loaded &&
        a.forbidden === b.forbidden &&
        a.failed === b.failed
    );
}

/** A key whose fetch has come back, either with rows or with a refusal. */
function isSettled(loaded: boolean, error: LoadFailure | null): boolean {
    return loaded || error !== null;
}

/**
 * The templates. Its own entity map, because a schedule and the periods it generates are different
 * rows: one is an arrangement that has no due date of its own, the other is a dated obligation.
 */
const ScheduleIndex = signalStore(
    {providedIn: 'root'},
    withEntities<RecurringExpense>(),
    withKeyedIndex<RecurringExpense, 'schedules'>({
        collection: 'schedules',
        sort: byNextDue,
        fetch: () => {
            const api = inject(BillApiService);
            return (channelId: string) =>
                api.listSchedules(channelId).pipe(map(rows => rows.map(normalizeRecurringExpense)));
        },
    }),
);

/** The periods. `BillOccurrence.recurringExpenseId` is the only link back to {@link ScheduleIndex}. */
const OccurrenceIndex = signalStore(
    {providedIn: 'root'},
    withEntities<BillOccurrence>(),
    withKeyedIndex<BillOccurrence, 'bills'>({
        collection: 'bills',
        sort: byDueDate,
        fetch: () => {
            const api = inject(BillApiService);
            return (channelId: string) => api.listBills(channelId).pipe(map(rows => rows.map(normalizeBill)));
        },
    }),
);

/**
 * Bills: the schedules a ledger channel holds and the periods they have generated.
 *
 * Kept apart from the ledger, and not because the endpoints are separate. A bill is an obligation
 * before it is an expense. Expenses are history, money that moved, and balances are derived from
 * them; a pending bill is money that has not moved, owed to a future date, and nothing about it
 * belongs in a balance.
 *
 * The one place they meet is {@link postBill}, which turns an obligation into history and therefore
 * has to invalidate the ledger's balances.
 */
export const BillStore = signalStore(
    {providedIn: 'root'},

    withMethods(() => {
        const api = inject(BillApiService);
        const ledger = inject(LedgerService);
        const templates = inject(ScheduleIndex);
        const periods = inject(OccurrenceIndex);

        const views = new Map<string, Signal<BillChannelState>>();
        const upcoming = new Map<string, Signal<BillOccurrence[]>>();

        // `Held` and not `Tracked`: a write reaches a channel nobody fetched and leaves an id list
        // with no request record behind it, and `Tracked` would make that channel realtime-deaf.
        const holdsSchedules = (channelId: string): boolean => templates.schedulesHeld(channelId);
        const holdsBills = (channelId: string): boolean => periods.billsHeld(channelId);

        const attachSchedule = (channelId: string, raw: RecurringExpense): void => {
            templates.attachToSchedules(channelId, normalizeRecurringExpense(raw));
        };

        /** Re-reads the periods only. The schedules are unchanged by anything that calls this. */
        const reloadBills = (channelId: string): void => {
            if (!holdsBills(channelId)) return;
            periods.loadBills(channelId, {force: true});
        };

        const dropSchedule = (channelId: string, templateId: string): void => {
            if (!holdsSchedules(channelId)) return;
            templates.detachFromSchedules(channelId, templateId);
            // Pending periods go with the schedule. Posted ones are expenses now and stay.
            periods.applyBills(
                channelId,
                periods
                    .billsFor(channelId)()
                    .filter(row => row.recurringExpenseId !== templateId || !isBillOutstanding(row)),
            );
        };

        return {
            // ── Reads ────────────────────────────────────────────────────────

            /** Never null. A channel nobody has opened reads as empty and untracked. */
            stateFor(channelId: string): Signal<BillChannelState> {
                const cached = views.get(channelId);
                if (cached) return cached;

                const view = computed(
                    () => {
                        const scheduleError = templates.schedulesError(channelId);
                        const billError = periods.billsError(channelId);
                        const forbidden = scheduleError === 'forbidden' || billError === 'forbidden';
                        return {
                            schedules: templates.schedulesFor(channelId)(),
                            bills: periods.billsFor(channelId)(),
                            loading: templates.schedulesLoading(channelId) || periods.billsLoading(channelId),
                            loaded:
                                isSettled(templates.schedulesLoaded(channelId), scheduleError) &&
                                isSettled(periods.billsLoaded(channelId), billError),
                            // One half refusing is enough: a 403 on either route is the module being off.
                            forbidden,
                            // Both halves, or the useful one still rendered under a banner saying nothing loaded.
                            failed: !forbidden && scheduleError !== null && billError !== null,
                        };
                    },
                    {equal: sameState},
                );

                views.set(channelId, view);
                return view;
            },

            /** Still owed, soonest first. What the upcoming board draws, and never ledger history. */
            upcomingFor(channelId: string): Signal<BillOccurrence[]> {
                const cached = upcoming.get(channelId);
                if (cached) return cached;

                const view = computed(() => periods.billsFor(channelId)().filter(isBillOutstanding), {
                    equal: sameRows,
                });

                upcoming.set(channelId, view);
                return view;
            },

            /** The template a period came from. The payer lives here, not on the occurrence. */
            scheduleFor(channelId: string, templateId: string): RecurringExpense | null {
                return (
                    templates
                        .schedulesFor(channelId)()
                        .find(row => row.id === templateId) ?? null
                );
            },

            // ── Loading ──────────────────────────────────────────────────────

            /** Idempotent per channel for the session; call it on every open. */
            loadFor(channelId: string): void {
                templates.loadSchedules(channelId);
                periods.loadBills(channelId);
            },

            /**
             * Forces a re-read of both halves. They are separate requests, so a schedule list that
             * 500s does not blank the periods that did arrive: the upcoming board is the useful half
             * and it does not need the templates to render.
             */
            refresh(channelId: string): void {
                templates.loadSchedules(channelId, {force: true});
                periods.loadBills(channelId, {force: true});
            },

            // ── Writes ───────────────────────────────────────────────────────

            addSchedule(channelId: string, body: CreateRecurringExpenseDto): Observable<RecurringExpense> {
                return api.createSchedule(channelId, body).pipe(tap(row => attachSchedule(channelId, row)));
            },

            editSchedule(
                channelId: string,
                templateId: string,
                body: UpdateRecurringExpenseDto,
            ): Observable<RecurringExpense> {
                return api.updateSchedule(templateId, body).pipe(
                    tap(row => {
                        attachSchedule(channelId, row);
                        // The edit moved the pending periods rather than regenerating them. The
                        // individual moves arrive as BillOccurrenceUpdated, but a schedule whose
                        // interval shrank can also drop periods, and there is no event for that.
                        reloadBills(channelId);
                    }),
                );
            },

            removeSchedule(channelId: string, templateId: string): Observable<void> {
                return api.deleteSchedule(templateId).pipe(tap(() => dropSchedule(channelId, templateId)));
            },

            /**
             * Turns one bill into a real expense. The bill's own row arrives as
             * `guild.BillOccurrenceUpdated`, but the expense it became is the ledger's and nothing
             * over there knows a bill was posted, so the balances are invalidated from here.
             */
            postBill(channelId: string, billId: string, body: PostBillDto = {}): Observable<Expense> {
                return api.postBill(billId, body).pipe(
                    tap(() => {
                        reloadBills(channelId);
                        ledger.refresh(channelId);
                    }),
                );
            },

            skipBill(channelId: string, billId: string, body: SkipBillDto = {}): Observable<BillOccurrence> {
                return api
                    .skipBill(billId, body)
                    .pipe(tap(row => periods.attachToBills(channelId, normalizeBill(row))));
            },

            // ── Realtime ─────────────────────────────────────────────────────
            //
            // Every handler bails on a channel nobody has opened. A board seeded with only what
            // happened since the socket connected is worse than a spinner until it is opened, and a
            // period that arrives twice is somebody paying the rent twice.

            applyScheduleUpserted({
                channelId,
                recurringExpense,
            }: RecurringExpenseCreated | RecurringExpenseUpdated): void {
                if (!holdsSchedules(channelId)) return;
                attachSchedule(channelId, recurringExpense);
            },

            applyScheduleDeleted({channelId, recurringExpenseId}: RecurringExpenseDeleted): void {
                dropSchedule(channelId, recurringExpenseId);
            },

            applyBillUpserted({channelId, bill}: BillOccurrenceCreated | BillOccurrenceUpdated): void {
                if (!holdsBills(channelId)) return;
                periods.attachToBills(channelId, normalizeBill(bill));
            },
        };
    }),

    withHooks({
        onInit(store) {
            const realtime = inject(RealtimeConnectionService);

            realtime.stream('guild.RecurringExpenseCreated').subscribe(e => store.applyScheduleUpserted(e));
            realtime.stream('guild.RecurringExpenseUpdated').subscribe(e => store.applyScheduleUpserted(e));
            realtime.stream('guild.RecurringExpenseDeleted').subscribe(e => store.applyScheduleDeleted(e));
            realtime.stream('guild.BillOccurrenceCreated').subscribe(e => store.applyBillUpserted(e));
            realtime.stream('guild.BillOccurrenceUpdated').subscribe(e => store.applyBillUpserted(e));
        },
    }),
);
