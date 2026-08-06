import {inject, Injectable, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {forkJoin, Observable, of, tap} from 'rxjs';
import {catchError} from 'rxjs/operators';
import {
    Expense,
    ExpenseCreated,
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
    CreateExpenseDto,
    RecordSettlementDto,
    UpdateExpenseDto,
    UpdateLedgerConfigDto,
} from '../dtos/request/ledger.dto';
import {EXPENSE_PAGE_SIZE, LedgerApiService} from './ledger-api.service';
import {RealtimeConnectionService} from './realtime-connection.service';

/** How many settlements to keep for the "recently settled" strip. They have no list endpoint. */
const RECENT_SETTLEMENT_LIMIT = 10;

/** What a ledger channel nobody has opened looks like, so `stateFor` never returns undefined. */
const EMPTY_STATE: LedgerChannelState = {
    expenses: [],
    nextCursor: null,
    loadingMore: false,
    balances: [],
    suggestions: [],
    recentSettlements: [],
    config: null,
    loading: false,
    loaded: false,
    forbidden: false,
    failed: false,
};

export interface LedgerChannelState {
    /** Newest first by `occurredAt`. However many pages have been asked for, not the whole ledger. */
    expenses: Expense[];
    /**
     * The cursor for the next page, or `null` when there is nothing behind what is loaded.
     *
     * <p>`null` is the only thing that means "the end". A page shorter than the limit does not -
     * the server may return fewer rows than asked for and still have more.</p>
     */
    nextCursor: string | null;
    /** A `loadMore` is in the air. Distinct from `loading`, which blanks the list. */
    loadingMore: boolean;
    /** Server-computed, always summing to zero, with members at zero already dropped. */
    balances: LedgerBalance[];
    suggestions: TransferSuggestion[];
    /** Only what has arrived over the socket this session - there is no settlements endpoint. */
    recentSettlements: Settlement[];
    config: LedgerConfig | null;
    loading: boolean;
    loaded: boolean;
    /**
     * A `403` came back.
     *
     * <p>Which far more often means the guild does not have the Ledger module than that this member
     * is not allowed to see it - the owner gets the same `403` in a Community guild. Callers render
     * *nothing* on this, never a denial: "your house doesn't do money" and "you're not allowed to
     * see the money" are different sentences and only one of them is usually true.</p>
     */
    forbidden: boolean;
    failed: boolean;
}

/**
 * Everything one household's ledger channels hold: expenses, balances, the settle-up plan and the
 * currency, kept per channel and kept live.
 *
 * <p><b>Balances are never computed here.</b> Every realtime event re-fetches them instead. The
 * temptation is obvious - the expense list is right there, the arithmetic is integer, it would be
 * one reduce - and it is wrong twice over: the list on screen is one channel's expenses and not
 * necessarily all of them, and settlements move balances without touching any expense at all. The
 * server owns the number; this owns a cache of it.</p>
 *
 * <p>Channels nobody has opened are ignored on every event. A household guild has one ledger, but a
 * guild with six would otherwise fire six balance fetches per expense anyone anywhere added.</p>
 */
@Injectable({providedIn: 'root'})
export class LedgerService {
    private api = inject(LedgerApiService);
    private realtime = inject(RealtimeConnectionService);

    private readonly states = signal<Record<string, LedgerChannelState>>({});

    /** Channels whose first load has been kicked off, so `loadFor` is free to call on every open. */
    private readonly requested = new Set<string>();

    /**
     * Channels with a balances round-trip in the air, and those that were invalidated while one
     * was.
     *
     * <p>Two people in the same shop is the normal case, so events arrive in bursts and each one
     * invalidates the same pair of endpoints. Without this a burst of five is ten requests whose
     * answers race; with it, it is one round-trip and then exactly one more, which is the smallest
     * number that can still be guaranteed to reflect the last event.</p>
     */
    private readonly balancesInFlight = new Set<string>();
    private readonly balancesDirty = new Set<string>();

    constructor() {
        // Registered once, here, in a root singleton: `RealtimeConnectionService.on` does not
        // deduplicate, so a second registration delivers every expense twice - and a double-counted
        // expense in a shared ledger is the kind of bug flatmates argue about. Safe before `start`;
        // handlers queued now are replayed onto the connection when it is built.
        this.realtime.on('guild.ExpenseCreated', (d: ExpenseCreated) => this.onExpenseCreated(d));
        this.realtime.on('guild.ExpenseUpdated', (d: ExpenseUpdated) => this.onExpenseUpdated(d));
        this.realtime.on('guild.ExpenseDeleted', (d: ExpenseDeleted) => this.onExpenseDeleted(d));
        this.realtime.on('guild.SettlementRecorded', (d: SettlementRecorded) => this.onSettlementRecorded(d));
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    stateFor(channelId: string): LedgerChannelState {
        return this.states()[channelId] ?? EMPTY_STATE;
    }

    /**
     * The currency to format this channel's amounts in.
     *
     * <p>The config is the answer; the newest expense is the stand-in for the moment before it
     * lands, because every expense carries the currency it was written under. `CHF` last, so a
     * cold, empty ledger renders numbers rather than a blank space - it is replaced the instant the
     * config request answers.</p>
     */
    currencyFor(channelId: string): string {
        const state = this.stateFor(channelId);
        return state.config?.currency ?? state.expenses[0]?.currency ?? 'CHF';
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

        // No cursor: a refresh re-reads the *first* page and replaces what was held. Carrying the
        // stored cursor over would append the page after the one that is about to be discarded and
        // leave a hole in the middle of the ledger.
        this.api.listExpenses(channelId).subscribe({
            next: page => this.patch(channelId, state => ({
                ...state,
                expenses: this.sorted((page.items ?? []).map(normalizeExpense)),
                nextCursor: page.nextCursor ?? null,
                loading: false,
                loadingMore: false,
                loaded: true,
            })),
            error: err => this.onLoadError(channelId, err),
        });

        this.api.getConfig(channelId).subscribe({
            // A missing config is survivable - `currencyFor` falls back to the expenses - so this
            // does not flag the channel as failed and does not block the rest of the view.
            next: config => this.patch(channelId, state => ({...state, config})),
            error: () => undefined,
        });

        this.refreshBalances(channelId);
    }

    /**
     * Appends the next page of expenses.
     *
     * <p>No-op when there is nothing behind what is loaded (`nextCursor === null`) or a page is
     * already in the air - the button can be bound straight to this without guarding either.</p>
     *
     * <p>A failure leaves the pages already loaded alone and keeps the cursor, so the button simply
     * comes back and can be pressed again. It deliberately does not set `failed`: that flag blanks
     * the whole panel, and losing the ledger you were reading because its <i>next</i> page timed
     * out is a far worse answer than one that says "load more" a second time.</p>
     */
    loadMore(channelId: string): void {
        const state = this.stateFor(channelId);
        if (!state.nextCursor || state.loadingMore || state.loading) return;

        const cursor = state.nextCursor;
        this.patch(channelId, current => ({...current, loadingMore: true}));

        this.api.listExpenses(channelId, EXPENSE_PAGE_SIZE, cursor).subscribe({
            next: page => this.patch(channelId, current => {
                // A `refresh` that landed while this page was in the air threw away everything this
                // page sits behind, and moved the cursor back to the top of the ledger. Applying
                // the page anyway would append rows from further down than the ones now held -
                // leaving a hole in the middle - and then point the cursor past it, so nothing
                // would ever fetch what was skipped. Dropping it costs one wasted request.
                if (current.nextCursor !== cursor) return {...current, loadingMore: false};

                return {
                    ...current,
                    // Merged by id rather than concatenated: an expense added while the page was in
                    // flight arrives over the socket too, and a cursor page can legitimately
                    // re-send a row the client already holds.
                    expenses: this.sorted(this.mergeById(current.expenses, (page.items ?? []).map(normalizeExpense))),
                    nextCursor: page.nextCursor ?? null,
                    loadingMore: false,
                };
            }),
            error: () => this.patch(channelId, current => ({...current, loadingMore: false})),
        });
    }

    /**
     * Re-reads balances and the settle-up plan together.
     *
     * <p>The plan is derived from the balances, so refreshing one without the other puts "Anna pays
     * Marco 42.00" next to a balance sheet that no longer says 42.00.</p>
     */
    refreshBalances(channelId: string): void {
        if (!this.states()[channelId]) return;

        if (this.balancesInFlight.has(channelId)) {
            this.balancesDirty.add(channelId);
            return;
        }
        this.balancesInFlight.add(channelId);

        forkJoin({
            // Failures are folded to null rather than allowed to collapse the pair: a settle
            // suggestion that 500s must not also blank out the balances that did arrive.
            balances: this.api.balances(channelId)
                .pipe(catchError((err: unknown) => this.swallow<LedgerBalance[]>(channelId, err))),
            suggestions: this.api.settleSuggestion(channelId)
                .pipe(catchError((err: unknown) => this.swallow<TransferSuggestion[]>(channelId, err))),
        }).subscribe(({balances, suggestions}) => {
            this.patch(channelId, state => ({
                ...state,
                balances: balances ?? state.balances,
                suggestions: suggestions ?? state.suggestions,
            }));

            this.balancesInFlight.delete(channelId);
            if (this.balancesDirty.delete(channelId)) this.refreshBalances(channelId);
        });
    }

    // ── Writes ───────────────────────────────────────────────────────────────
    //
    // Each applies its own response locally and then re-fetches balances, rather than waiting for
    // the socket echo. The echo still arrives and is still applied - both paths are keyed on the
    // expense id, so applying the same expense twice is a no-op.

    addExpense(channelId: string, body: CreateExpenseDto): Observable<Expense> {
        return this.api.createExpense(channelId, body).pipe(tap(expense => {
            this.upsertExpense(channelId, expense);
            this.refreshBalances(channelId);
        }));
    }

    editExpense(channelId: string, expenseId: string, body: UpdateExpenseDto): Observable<Expense> {
        return this.api.updateExpense(expenseId, body).pipe(tap(expense => {
            this.upsertExpense(channelId, expense);
            this.refreshBalances(channelId);
        }));
    }

    removeExpense(channelId: string, expenseId: string): Observable<void> {
        return this.api.deleteExpense(expenseId).pipe(tap(() => {
            this.dropExpense(channelId, expenseId);
            this.refreshBalances(channelId);
        }));
    }

    /** Records that a payment happened. Nothing moves; the balances just stop saying it is owed. */
    recordSettlement(channelId: string, body: RecordSettlementDto): Observable<Settlement> {
        return this.api.recordSettlement(channelId, body).pipe(tap(settlement => {
            this.rememberSettlement(channelId, settlement);
            this.refreshBalances(channelId);
        }));
    }

    /**
     * Writes the ledger's currency.
     *
     * <p>Relabelling only: every stored `amountMinor` keeps its digits, so a ledger flipped from CHF
     * to EUR still says 1234 and now calls it €12.34. Callers must have said so out loud before
     * getting here.</p>
     */
    saveConfig(channelId: string, body: UpdateLedgerConfigDto): Observable<LedgerConfig> {
        return this.api.updateConfig(channelId, body).pipe(tap(config =>
            this.patch(channelId, state => ({...state, config}))));
    }

    // ── Realtime ─────────────────────────────────────────────────────────────

    private onExpenseCreated(event: ExpenseCreated): void {
        this.upsertExpense(event.channelId, event.expense);
        this.refreshBalances(event.channelId);
    }

    private onExpenseUpdated(event: ExpenseUpdated): void {
        this.upsertExpense(event.channelId, event.expense);
        this.refreshBalances(event.channelId);
    }

    private onExpenseDeleted(event: ExpenseDeleted): void {
        this.dropExpense(event.channelId, event.expenseId);
        this.refreshBalances(event.channelId);
    }

    /**
     * A settlement touches no expense at all - which is exactly why balances have to be re-fetched
     * rather than derived. Nothing else on screen would have changed.
     */
    private onSettlementRecorded(event: SettlementRecorded): void {
        this.rememberSettlement(event.channelId, event.settlement);
        this.refreshBalances(event.channelId);
    }

    // ── State plumbing ───────────────────────────────────────────────────────

    private upsertExpense(channelId: string, raw: Expense): void {
        const expense = normalizeExpense(raw);
        this.patchExisting(channelId, state => ({
            ...state,
            expenses: this.sorted([...state.expenses.filter(e => e.id !== expense.id), expense]),
        }));
    }

    private dropExpense(channelId: string, expenseId: string): void {
        this.patchExisting(channelId, state => ({
            ...state,
            expenses: state.expenses.filter(e => e.id !== expenseId),
        }));
    }

    private rememberSettlement(channelId: string, settlement: Settlement): void {
        this.patchExisting(channelId, state => ({
            ...state,
            recentSettlements: [
                settlement,
                ...state.recentSettlements.filter(s => s.id !== settlement.id),
            ].slice(0, RECENT_SETTLEMENT_LIMIT),
        }));
    }

    /**
     * Adds the rows this channel does not already hold, and keeps the ones it does.
     *
     * <p>What is held wins the clash deliberately. A page is a snapshot from when the request was
     * sent, so an expense edited over the socket while it was in flight comes back stale in it -
     * and this only ever runs for {@link loadMore}, which reaches *backwards* into pages the client
     * has never seen. Overlap is the rare case; a page silently reverting an edit is not worth
     * paying for it.</p>
     */
    private mergeById(existing: Expense[], incoming: Expense[]): Expense[] {
        const held = new Set(existing.map(e => e.id));
        return [...existing, ...incoming.filter(e => !held.has(e.id))];
    }

    /**
     * Newest first.
     *
     * <p>`occurredAt` and not the id: an expense is dated by when the shop happened, not when
     * someone got round to typing it in, and ids only sort by creation time if they were minted
     * after the ULID change. The id is the tiebreak purely so two same-day expenses hold a stable
     * order between renders.</p>
     */
    private sorted(expenses: Expense[]): Expense[] {
        return [...expenses].sort((a, b) =>
            b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
    }

    private patch(channelId: string, fn: (state: LedgerChannelState) => LedgerChannelState): void {
        this.states.update(all => ({...all, [channelId]: fn(all[channelId] ?? EMPTY_STATE)}));
    }

    /** As {@link patch}, but silently drops events for channels nobody has opened. */
    private patchExisting(channelId: string, fn: (state: LedgerChannelState) => LedgerChannelState): void {
        this.states.update(all => all[channelId] ? {...all, [channelId]: fn(all[channelId])} : all);
    }

    private onLoadError(channelId: string, err: unknown): void {
        const forbidden = err instanceof HttpErrorResponse && err.status === 403;
        this.patch(channelId, state => ({...state, loading: false, forbidden, failed: !forbidden}));
    }

    private swallow<T>(channelId: string, err: unknown): Observable<T | null> {
        if (err instanceof HttpErrorResponse && err.status === 403) {
            this.patch(channelId, state => ({...state, forbidden: true, loading: false}));
        }
        return of(null);
    }
}
