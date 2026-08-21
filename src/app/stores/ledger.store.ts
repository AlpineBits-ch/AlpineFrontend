import {computed, inject, Signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {catchError, forkJoin, map, Observable, of, tap} from 'rxjs';
import {patchState, signalStore, withHooks, withMethods, withState} from '@ngrx/signals';
import {removeEntity, withEntities} from '@ngrx/signals/entities';
import {
    Expense,
    ExpenseCategory,
    ExpenseCreated,
    ExpensePage,
    ExpenseDeleted,
    ExpenseUpdated,
    LedgerBalance,
    LedgerConfig,
    normalizeExpense,
    Settlement,
    SettlementRecorded,
    TransferSuggestion,
} from '../dtos/response/ledger.dto';
import {
    ExpenseReceipt,
    ExpenseReceiptAdded,
    ExpenseReceiptDeleted,
    LedgerSummary,
} from '../dtos/response/ledger-insight.dto';
import {
    CreateExpenseDto,
    RecordSettlementDto,
    UpdateExpenseDto,
    UpdateLedgerConfigDto,
} from '../dtos/request/ledger.dto';
import {EXPENSE_PAGE_SIZE, LedgerApiService} from '../services/ledger-api.service';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {withKeyedIndex} from './foundation/with-keyed-index';

/** How many settlements to keep for the "recently settled" strip. They have no list endpoint. */
const RECENT_SETTLEMENT_LIMIT = 10;

export interface LedgerChannelState {
    /** Newest first by `occurredAt`. However many pages have been asked for, not the whole ledger. */
    expenses: Expense[];
    /**
     * The cursor for the next page, or `null` when there is nothing behind what is loaded. `null` is
     * the only thing that means "the end": a page shorter than the limit does not.
     */
    nextCursor: string | null;
    /** A `loadMore` is in the air. Distinct from `loading`, which blanks the list. */
    loadingMore: boolean;
    /** Server-computed, always summing to zero, with members at zero already dropped. */
    balances: LedgerBalance[];
    suggestions: TransferSuggestion[];
    /** Only what has arrived over the socket this session. There is no settlements endpoint. */
    recentSettlements: Settlement[];
    config: LedgerConfig | null;
    /**
     * The category the loaded pages were filtered to, or `null` for everything. A `nextCursor` was
     * minted under one filter, so paging it under another interleaves two different queries.
     */
    category: ExpenseCategory | null;
    loading: boolean;
    loaded: boolean;
    /**
     * A `403` came back, which far more often means the guild does not have the Ledger module than
     * that this member is refused: the owner gets the same `403` in a Community guild. Callers render
     * nothing at all on this, never a denial.
     */
    forbidden: boolean;
    failed: boolean;
}

/** What a ledger channel nobody has opened looks like, so `stateFor` never returns undefined. */
const EMPTY_STATE: LedgerChannelState = {
    expenses: [],
    nextCursor: null,
    loadingMore: false,
    balances: [],
    suggestions: [],
    recentSettlements: [],
    config: null,
    category: null,
    loading: false,
    loaded: false,
    forbidden: false,
    failed: false,
};

/** The spending rollup for one channel, plus enough to know whether it is the one being asked for. */
export interface LedgerSummaryState {
    summary: LedgerSummary | null;
    /** How many months back the loaded summary covers, so a window change is detectable. */
    months: number;
    loading: boolean;
    failed: boolean;
}

const EMPTY_SUMMARY_STATE: LedgerSummaryState = {
    summary: null,
    months: 0,
    loading: false,
    failed: false,
};

/** What the loaded pages mean: the filter they ran under, and where the one behind them starts. */
interface ExpensePaging {
    nextCursor: string | null;
    loadingMore: boolean;
    category: ExpenseCategory | null;
}

const EMPTY_PAGING: ExpensePaging = {nextCursor: null, loadingMore: false, category: null};

/**
 * The money side of a ledger channel. A balance and a transfer suggestion carry no id at all, and a
 * settlement has no list endpoint, so none of the three can be a keyed index over an entity map.
 */
interface LedgerPosition {
    balances: LedgerBalance[];
    suggestions: TransferSuggestion[];
    recentSettlements: Settlement[];
    /** A balances or settle-suggestion read answered 403. The expense index carries its own error. */
    forbidden: boolean;
}

const EMPTY_POSITION: LedgerPosition = {
    balances: [],
    suggestions: [],
    recentSettlements: [],
    forbidden: false,
};

interface LedgerState {
    paging: Record<string, ExpensePaging>;
    positions: Record<string, LedgerPosition>;
    configs: Record<string, LedgerConfig>;
    /** Ids per expense, never the receipts: a receipt url is presigned and starts 403ing on expiry. */
    receiptIds: Record<string, string[]>;
    summaries: Record<string, LedgerSummaryState>;
}

/** One first-page request: the filter it runs under. */
interface ExpenseQuery {
    category: ExpenseCategory | null;
}

/**
 * Newest first. `occurredAt` and not the id: an expense is dated by when the shop happened, not by
 * when someone got round to typing it in. The id is the tiebreak so two same-day rows hold a stable
 * order between renders.
 */
function byOccurredAt(a: Expense, b: Expense): number {
    return b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id);
}

function sameState(a: LedgerChannelState, b: LedgerChannelState): boolean {
    return (
        a.expenses === b.expenses &&
        a.nextCursor === b.nextCursor &&
        a.loadingMore === b.loadingMore &&
        a.balances === b.balances &&
        a.suggestions === b.suggestions &&
        a.recentSettlements === b.recentSettlements &&
        a.config === b.config &&
        a.category === b.category &&
        a.loading === b.loading &&
        a.loaded === b.loaded &&
        a.forbidden === b.forbidden &&
        a.failed === b.failed
    );
}

/**
 * Everything one household's ledger channels hold: expenses, balances, the settle-up plan and the
 * currency, kept per channel and kept live.
 *
 * Balances are never computed here. Every realtime event re-fetches them instead, because the list on
 * screen is one channel's expenses and not necessarily all of them, and a settlement moves balances
 * without touching any expense at all. The server owns the number; this owns a cache of it.
 *
 * Channels nobody has opened are dropped on every event. A household guild has one ledger, but a
 * guild with six would otherwise fire six balance fetches per expense anyone anywhere added.
 */
export const LedgerStore = signalStore(
    {providedIn: 'root'},
    withEntities<Expense>(),
    withState<LedgerState>({paging: {}, positions: {}, configs: {}, receiptIds: {}, summaries: {}}),

    withKeyedIndex<Expense, 'expenses', ExpenseQuery, ExpensePage, LedgerState>({
        collection: 'expenses',
        sort: byOccurredAt,
        fetch: () => {
            const api = inject(LedgerApiService);
            // Always the first page. Carrying a stored cursor here would append the page after the
            // one about to be discarded and leave a hole in the middle of the ledger.
            return (channelId: string, query?: ExpenseQuery) =>
                api.listExpenses(channelId, EXPENSE_PAGE_SIZE, null, query?.category ?? null);
        },
        rows: page => (page.items ?? []).map(normalizeExpense),
        // A first page landing supersedes whatever `loadMore` had in the air.
        onLoaded: (page, channelId, state) => ({
            paging: {
                ...state.paging,
                [channelId]: {
                    ...(state.paging[channelId] ?? EMPTY_PAGING),
                    nextCursor: page.nextCursor ?? null,
                    loadingMore: false,
                },
            },
        }),
    }),

    withMethods((store, api = inject(LedgerApiService)) => {
        const views = new Map<string, Signal<LedgerChannelState>>();

        // Channels with a balances round-trip in the air, and those invalidated while one was. A
        // burst of five events is then one round-trip and exactly one more, which is the smallest
        // number that still reflects the last event.
        const balancesInFlight = new Set<string>();
        const balancesDirty = new Set<string>();

        const pagingOf = (channelId: string): ExpensePaging => store.paging()[channelId] ?? EMPTY_PAGING;

        const positionOf = (channelId: string): LedgerPosition =>
            store.positions()[channelId] ?? EMPTY_POSITION;

        const patchPaging = (channelId: string, changes: Partial<ExpensePaging>): void => {
            patchState(store, {
                paging: {...store.paging(), [channelId]: {...pagingOf(channelId), ...changes}},
            });
        };

        const patchPosition = (channelId: string, changes: Partial<LedgerPosition>): void => {
            patchState(store, {
                positions: {...store.positions(), [channelId]: {...positionOf(channelId), ...changes}},
            });
        };

        const putConfig = (channelId: string, config: LedgerConfig): void => {
            patchState(store, {configs: {...store.configs(), [channelId]: config}});
        };

        const fetchConfig = (channelId: string): void => {
            // A missing config is survivable, `currencyFor` falls back to the expenses, so this does
            // not flag the channel as failed and does not block the rest of the view.
            api.getConfig(channelId).subscribe({
                next: config => putConfig(channelId, config),
                error: () => undefined,
            });
        };

        const swallow = <T>(channelId: string, err: unknown): Observable<T | null> => {
            if (err instanceof HttpErrorResponse && err.status === 403) {
                patchPosition(channelId, {forbidden: true});
            }
            return of(null);
        };

        /**
         * Re-reads balances and the settle-up plan together. The plan is derived from the balances,
         * so refreshing one without the other puts "Anna pays Marco 42.00" next to a balance sheet
         * that no longer says 42.00.
         */
        const refreshBalances = (channelId: string): void => {
            if (!store.expensesTracked(channelId)) return;

            if (balancesInFlight.has(channelId)) {
                balancesDirty.add(channelId);
                return;
            }
            balancesInFlight.add(channelId);

            forkJoin({
                // Failures fold to null rather than collapsing the pair: a settle suggestion that
                // 500s must not blank out the balances that did arrive.
                balances: api
                    .balances(channelId)
                    .pipe(catchError((err: unknown) => swallow<LedgerBalance[]>(channelId, err))),
                suggestions: api
                    .settleSuggestion(channelId)
                    .pipe(catchError((err: unknown) => swallow<TransferSuggestion[]>(channelId, err))),
            }).subscribe(({balances, suggestions}) => {
                const held = positionOf(channelId);
                patchPosition(channelId, {
                    balances: balances ?? held.balances,
                    suggestions: suggestions ?? held.suggestions,
                });

                balancesInFlight.delete(channelId);
                if (balancesDirty.delete(channelId)) refreshBalances(channelId);
            });
        };

        const queryFor = (channelId: string): ExpenseQuery => ({
            category: pagingOf(channelId).category,
        });

        const refresh = (channelId: string): void => {
            store.loadExpenses(channelId, {force: true, arg: queryFor(channelId)});
            fetchConfig(channelId);
            refreshBalances(channelId);
        };

        const upsertExpense = (channelId: string, raw: Expense): void => {
            if (!store.expensesTracked(channelId)) return;
            store.attachToExpenses(channelId, normalizeExpense(raw));
        };

        const dropExpense = (channelId: string, expenseId: string): void => {
            if (!store.expensesTracked(channelId)) return;
            store.detachFromExpenses(channelId, expenseId);
            patchState(store, removeEntity(expenseId));
        };

        const rememberSettlement = (channelId: string, settlement: Settlement): void => {
            if (!store.expensesTracked(channelId)) return;
            const held = positionOf(channelId).recentSettlements;
            patchPosition(channelId, {
                recentSettlements: [settlement, ...held.filter(s => s.id !== settlement.id)].slice(
                    0,
                    RECENT_SETTLEMENT_LIMIT,
                ),
            });
        };

        /** A fresh listing is authoritative and replaces whatever the events had accumulated. */
        const setReceiptIds = (expenseId: string, ids: string[]): void => {
            patchState(store, {receiptIds: {...store.receiptIds(), [expenseId]: ids}});
        };

        const addReceiptId = (expenseId: string, receiptId: string | undefined): void => {
            if (!receiptId) return;
            const held = store.receiptIds()[expenseId] ?? [];
            if (held.includes(receiptId)) return;
            patchState(store, {receiptIds: {...store.receiptIds(), [expenseId]: [...held, receiptId]}});
        };

        const dropReceiptId = (expenseId: string, receiptId: string): void => {
            const held = store.receiptIds()[expenseId];
            if (!held) return;
            patchState(store, {
                receiptIds: {...store.receiptIds(), [expenseId]: held.filter(id => id !== receiptId)},
            });
        };

        const patchSummary = (
            channelId: string,
            fn: (state: LedgerSummaryState) => LedgerSummaryState,
        ): void => {
            const all = store.summaries();
            patchState(store, {
                summaries: {...all, [channelId]: fn(all[channelId] ?? EMPTY_SUMMARY_STATE)},
            });
        };

        /**
         * Adds the rows this channel does not already hold, and keeps the ones it does. What is held
         * wins the clash: a page is a snapshot from when the request was sent, and this only runs for
         * `loadMore`, which reaches backwards into pages the client has never seen.
         */
        const mergeById = (existing: Expense[], incoming: Expense[]): Expense[] => {
            const held = new Set(existing.map(e => e.id));
            return [...existing, ...incoming.filter(e => !held.has(e.id))];
        };

        const stateView = (channelId: string): Signal<LedgerChannelState> => {
            const cached = views.get(channelId);
            if (cached) return cached;

            const view = computed(
                () => {
                    const paging = store.paging()[channelId];
                    const position = store.positions()[channelId];
                    const config = store.configs()[channelId] ?? null;
                    const tracked = store.expensesTracked(channelId);
                    if (!tracked && !paging && !position && !config) return EMPTY_STATE;

                    const page = paging ?? EMPTY_PAGING;
                    const held = position ?? EMPTY_POSITION;
                    const error = store.expensesError(channelId);
                    return {
                        expenses: store.expensesFor(channelId)(),
                        nextCursor: page.nextCursor,
                        loadingMore: page.loadingMore,
                        balances: held.balances,
                        suggestions: held.suggestions,
                        recentSettlements: held.recentSettlements,
                        config,
                        category: page.category,
                        loading: store.expensesLoading(channelId),
                        loaded: store.expensesLoaded(channelId),
                        forbidden: error === 'forbidden' || held.forbidden,
                        failed: error === 'failed',
                    };
                },
                {equal: sameState},
            );

            views.set(channelId, view);
            return view;
        };

        return {
            // ── Reads ────────────────────────────────────────────────────────

            stateFor: stateView,

            /**
             * The config is the answer; the newest expense stands in for the moment before it lands,
             * because every expense carries the currency it was written under. `CHF` last, so a cold
             * ledger renders numbers rather than a blank space.
             */
            currencyFor(channelId: string): string {
                const config = store.configs()[channelId];
                return config?.currency ?? store.expensesFor(channelId)()[0]?.currency ?? 'CHF';
            },

            /** How many receipts an expense is known to have. `0` also covers "nobody has looked yet". */
            receiptCountFor(expenseId: string): number {
                return store.receiptIds()[expenseId]?.length ?? 0;
            },

            summaryFor(channelId: string): LedgerSummaryState {
                return store.summaries()[channelId] ?? EMPTY_SUMMARY_STATE;
            },

            // ── Loading ──────────────────────────────────────────────────────

            /** Idempotent per channel for the session; safe on every open. */
            loadFor(channelId: string): void {
                if (store.expensesTracked(channelId)) return;
                refresh(channelId);
            },

            refresh,

            /**
             * Appends the next page. A no-op when there is nothing behind what is loaded or a page is
             * already in the air, so the button can be bound straight to it.
             *
             * A failure keeps the pages already loaded and the cursor, and deliberately does not set
             * `failed`: that flag blanks the whole panel, and losing the ledger you were reading
             * because its next page timed out is a far worse answer than a second press.
             */
            loadMore(channelId: string): void {
                const paging = pagingOf(channelId);
                if (!paging.nextCursor || paging.loadingMore || store.expensesLoading(channelId)) return;

                const cursor = paging.nextCursor;
                patchPaging(channelId, {loadingMore: true});

                api.listExpenses(channelId, EXPENSE_PAGE_SIZE, cursor, paging.category).subscribe({
                    next: page => {
                        // A refresh that landed while this was in the air threw away everything these
                        // rows sit behind and moved the cursor back to the top. Taking them would
                        // leave a hole, and the cursor would then point past it forever.
                        if (pagingOf(channelId).nextCursor !== cursor) {
                            patchPaging(channelId, {loadingMore: false});
                            return;
                        }

                        // Merged by id rather than concatenated: an expense added while the page was
                        // in flight arrives over the socket too, and a cursor page can legitimately
                        // re-send a row the client already holds.
                        store.applyExpenses(
                            channelId,
                            mergeById(
                                store.expensesFor(channelId)(),
                                (page.items ?? []).map(normalizeExpense),
                            ),
                        );
                        patchPaging(channelId, {nextCursor: page.nextCursor ?? null, loadingMore: false});
                    },
                    error: () => patchPaging(channelId, {loadingMore: false}),
                });
            },

            /**
             * Narrows the expense list to one category, or to everything with `null`. Re-reads from
             * the first page rather than filtering what is held: the filter has to reach past the
             * rows on screen, and the stored cursor was minted under the old filter. Balances are
             * untouched, the house's position is not a property of what the reader is looking at.
             */
            setCategory(channelId: string, category: ExpenseCategory | null): void {
                if (pagingOf(channelId).category === category) return;
                patchPaging(channelId, {category, nextCursor: null});
                refresh(channelId);
            },

            /**
             * Loads the spending rollup for the last `months` months. Always fetched, never served
             * from a different window: "what did we spend this quarter" and "this year" are different
             * questions, and answering one with the other silently is worse than a spinner.
             */
            loadSummary(channelId: string, months: number): void {
                const current = store.summaries()[channelId] ?? EMPTY_SUMMARY_STATE;
                if (current.loading && current.months === months) return;

                patchSummary(channelId, state => ({...state, months, loading: true, failed: false}));

                const from = new Date();
                from.setMonth(from.getMonth() - months);

                api.summary(channelId, {from: from.toISOString()}).subscribe({
                    next: summary =>
                        patchSummary(channelId, state =>
                            // Dropped if the window moved on while this was in the air: the answer is
                            // for a question nobody is asking any more.
                            state.months === months ? {...state, summary, loading: false} : state,
                        ),
                    error: () =>
                        patchSummary(channelId, state =>
                            state.months === months ? {...state, loading: false, failed: true} : state,
                        ),
                });
            },

            // ── Receipts ─────────────────────────────────────────────────────

            /** Passes straight through with no caching. What it keeps is the count for the paperclip. */
            listReceipts(expenseId: string): Observable<ExpenseReceipt[]> {
                return api.listReceipts(expenseId).pipe(
                    tap(receipts =>
                        setReceiptIds(
                            expenseId,
                            receipts.map(r => r.id),
                        ),
                    ),
                );
            },

            uploadReceipt(expenseId: string, file: File): Observable<ExpenseReceipt> {
                return api
                    .uploadReceipt(expenseId, file)
                    .pipe(tap(receipt => addReceiptId(expenseId, receipt.id)));
            },

            removeReceipt(expenseId: string, receiptId: string): Observable<void> {
                return api.deleteReceipt(receiptId).pipe(tap(() => dropReceiptId(expenseId, receiptId)));
            },

            refreshBalances,

            // ── Writes ───────────────────────────────────────────────────────
            //
            // Each applies its own response locally and then re-fetches balances, rather than waiting
            // for the socket echo. The echo still arrives and is still applied: both paths key on the
            // expense id, so applying the same expense twice is a no-op.

            addExpense(channelId: string, body: CreateExpenseDto): Observable<Expense> {
                return api.createExpense(channelId, body).pipe(
                    tap(expense => {
                        upsertExpense(channelId, expense);
                        refreshBalances(channelId);
                    }),
                );
            },

            editExpense(channelId: string, expenseId: string, body: UpdateExpenseDto): Observable<Expense> {
                return api.updateExpense(expenseId, body).pipe(
                    tap(expense => {
                        upsertExpense(channelId, expense);
                        refreshBalances(channelId);
                    }),
                );
            },

            removeExpense(channelId: string, expenseId: string): Observable<void> {
                return api.deleteExpense(expenseId).pipe(
                    tap(() => {
                        dropExpense(channelId, expenseId);
                        refreshBalances(channelId);
                    }),
                );
            },

            /** Records that a payment happened. Nothing moves; the balances stop saying it is owed. */
            recordSettlement(channelId: string, body: RecordSettlementDto): Observable<Settlement> {
                return api.recordSettlement(channelId, body).pipe(
                    tap(settlement => {
                        rememberSettlement(channelId, settlement);
                        refreshBalances(channelId);
                    }),
                );
            },

            /**
             * Relabelling only: every stored `amountMinor` keeps its digits, so a ledger flipped from
             * CHF to EUR still says 1234 and now calls it 12.34 euro.
             */
            saveConfig(channelId: string, body: UpdateLedgerConfigDto): Observable<LedgerConfig> {
                return api.updateConfig(channelId, body).pipe(tap(config => putConfig(channelId, config)));
            },

            // ── Realtime ─────────────────────────────────────────────────────

            applyExpenseUpserted(event: ExpenseCreated | ExpenseUpdated): void {
                upsertExpense(event.channelId, event.expense);
                refreshBalances(event.channelId);
            },

            applyExpenseDeleted(event: ExpenseDeleted): void {
                dropExpense(event.channelId, event.expenseId);
                refreshBalances(event.channelId);
            },

            /**
             * A settlement touches no expense at all, which is exactly why balances are re-fetched
             * rather than derived. Nothing else on screen would have changed.
             */
            applySettlementRecorded(event: SettlementRecorded): void {
                rememberSettlement(event.channelId, event.settlement);
                refreshBalances(event.channelId);
            },

            /**
             * Only the id is kept. The event carries the whole receipt, presigned url and all, and
             * storing that url is the mistake this shape exists to avoid.
             */
            applyReceiptAdded(event: ExpenseReceiptAdded): void {
                addReceiptId(event.expenseId, event.receipt?.id);
            },

            applyReceiptDeleted(event: ExpenseReceiptDeleted): void {
                dropReceiptId(event.expenseId, event.receiptId);
            },
        };
    }),

    withHooks({
        onInit(store) {
            const realtime = inject(RealtimeConnectionService);

            realtime.stream('guild.ExpenseCreated').subscribe(e => store.applyExpenseUpserted(e));
            realtime.stream('guild.ExpenseUpdated').subscribe(e => store.applyExpenseUpserted(e));
            realtime.stream('guild.ExpenseDeleted').subscribe(e => store.applyExpenseDeleted(e));
            realtime.stream('guild.SettlementRecorded').subscribe(e => store.applySettlementRecorded(e));
            realtime.stream('guild.ExpenseReceiptAdded').subscribe(e => store.applyReceiptAdded(e));
            realtime.stream('guild.ExpenseReceiptDeleted').subscribe(e => store.applyReceiptDeleted(e));
        },
    }),
);
