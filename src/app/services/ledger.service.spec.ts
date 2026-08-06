import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {describe, expect, it} from 'vitest';

import {LedgerService} from './ledger.service';
import {ApiConfigService} from './api-config.service';
import {RealtimeConnectionService} from './realtime-connection.service';
import {
    Expense,
    ExpenseSplitKind,
    LedgerBalance,
    Settlement,
    TransferSuggestion,
} from '../dtos/response/ledger.dto';
import {normalizeCurrencyCode} from '../dtos/request/ledger.dto';

const BASE = 'https://api.test.example';
const GUILD = `${BASE}/api/v1/guild`;
const CHANNEL = 'chan_ledger';

/**
 * The body as it reaches the server, not as it was handed to HttpClient.
 *
 * <p>The JSON round-trip is the point: it drops `undefined` keys, so an assertion on it catches a
 * field meant to be omitted that is in fact being sent as `null`, and the reverse. These DTOs were
 * written against an inferred shape, and the wire is the only place the inference is checkable.</p>
 */
function wireBody(body: unknown): unknown {
    return JSON.parse(JSON.stringify(body));
}

/** Handlers the service registered on the fake hub, so a test can fire a server event by name. */
const hubHandlers = new Map<string, (payload: unknown) => void>();

function expense(overrides: Partial<Expense> = {}): Expense {
    return {
        id: 'expe_1',
        channelId: CHANNEL,
        payerUserId: 'user_anna',
        description: 'Migros',
        amountMinor: 1000,
        currency: 'CHF',
        occurredAt: '2026-08-01T10:00:00Z',
        splitKind: ExpenseSplitKind.Equal,
        createdByUserId: 'user_marco',
        shares: [],
        ...overrides,
    };
}

function settlement(overrides: Partial<Settlement> = {}): Settlement {
    return {
        id: 'sett_1',
        fromUserId: 'user_marco',
        toUserId: 'user_anna',
        amountMinor: 334,
        settledAt: '2026-08-02T18:00:00Z',
        recordedByUserId: 'user_marco',
        ...overrides,
    };
}

function setup() {
    hubHandlers.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {
                provide: RealtimeConnectionService,
                useValue: {
                    on: (event: string, handler: (payload: unknown) => void) =>
                        hubHandlers.set(event, handler),
                },
            },
        ],
    });
    return {
        service: TestBed.inject(LedgerService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

/**
 * The one expense request in the air, matched on path alone.
 *
 * <p>The URL carries `?limit=` (and `?cursor=` on a later page), so an exact-string `expectOne`
 * matches nothing.</p>
 */
function expectExpenses(ctrl: HttpTestingController) {
    return ctrl.expectOne(r => r.url === `${GUILD}/channels/${CHANNEL}/expenses`);
}

/** Answers the three requests one `loadFor` fires, so a test can start from a loaded channel. */
function answerLoad(
    ctrl: HttpTestingController,
    opts: {
        expenses?: Expense[];
        balances?: LedgerBalance[];
        suggestions?: TransferSuggestion[];
        nextCursor?: string | null;
    } = {},
): void {
    expectExpenses(ctrl).flush({items: opts.expenses ?? [], nextCursor: opts.nextCursor ?? null});
    ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/ledger/config`).flush({channelId: CHANNEL, currency: 'CHF'});
    ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/ledger/balances`).flush(opts.balances ?? []);
    ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/ledger/settle-suggestion`).flush(opts.suggestions ?? []);
}

/** Answers whatever balances round-trip is currently in the air. */
function answerBalances(
    ctrl: HttpTestingController,
    balances: LedgerBalance[] = [],
    suggestions: TransferSuggestion[] = [],
): void {
    ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/ledger/balances`).flush(balances);
    ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/ledger/settle-suggestion`).flush(suggestions);
}

describe('LedgerService', () => {
    describe('registration', () => {
        it('registers each realtime handler exactly once', () => {
            setup();
            expect([...hubHandlers.keys()].sort()).toEqual([
                'guild.ExpenseCreated',
                'guild.ExpenseDeleted',
                'guild.ExpenseUpdated',
                'guild.SettlementRecorded',
            ]);
        });
    });

    describe('loading', () => {
        it('fetches expenses, config, balances and the settle plan on first open', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl, {expenses: [expense()]});

            expect(service.stateFor(CHANNEL).expenses.length).toBe(1);
            expect(service.stateFor(CHANNEL).loaded).toBe(true);
            expect(service.currencyFor(CHANNEL)).toBe('CHF');
            ctrl.verify();
        });

        it('is idempotent per channel, so opening a ledger twice costs one round-trip', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl);
            service.loadFor(CHANNEL);
            ctrl.verify();
        });

        it('sorts expenses newest first by when the money was spent, not when it was typed in', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl, {
                expenses: [
                    expense({id: 'expe_old', occurredAt: '2026-07-01T00:00:00Z'}),
                    expense({id: 'expe_new', occurredAt: '2026-08-01T00:00:00Z'}),
                ],
            });
            expect(service.stateFor(CHANNEL).expenses.map(e => e.id)).toEqual(['expe_new', 'expe_old']);
        });

        it('treats a 403 as "there may be no module here" and never as data', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            expectExpenses(ctrl)
                .flush('Ledger is not enabled', {status: 403, statusText: 'Forbidden'});
            ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/ledger/config`)
                .flush(null, {status: 403, statusText: 'Forbidden'});
            answerBalances(ctrl);

            expect(service.stateFor(CHANNEL).forbidden).toBe(true);
            // Not "failed": a failure gets an error message, and this must get silence.
            expect(service.stateFor(CHANNEL).failed).toBe(false);
        });

        it('normalizes an integer splitKind from a host without the string enum converter', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl, {expenses: [expense({splitKind: 1 as unknown as ExpenseSplitKind})]});
            expect(service.stateFor(CHANNEL).expenses[0].splitKind).toBe(ExpenseSplitKind.Shares);
        });
    });

    describe('paging', () => {
        it('reads the page shape rather than a bare array, and keeps the cursor', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl, {expenses: [expense()], nextCursor: 'cursor_1'});

            expect(service.stateFor(CHANNEL).expenses.length).toBe(1);
            expect(service.stateFor(CHANNEL).nextCursor).toBe('cursor_1');
        });

        it('asks for the next page with the cursor the server handed back', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl, {expenses: [expense({id: 'expe_1'})], nextCursor: 'cursor_1'});

            service.loadMore(CHANNEL);
            const request = expectExpenses(ctrl);
            expect(request.request.params.get('cursor')).toBe('cursor_1');
            expect(request.request.params.get('limit')).toBe('50');

            request.flush({
                items: [expense({id: 'expe_0', occurredAt: '2026-07-01T00:00:00Z'})],
                nextCursor: null,
            });

            // Appended, not replaced - and the end of the ledger is the null cursor.
            expect(service.stateFor(CHANNEL).expenses.map(e => e.id)).toEqual(['expe_1', 'expe_0']);
            expect(service.stateFor(CHANNEL).nextCursor).toBeNull();
        });

        it('does nothing when there is no cursor, so the end of the ledger is not re-requested', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl, {expenses: [expense()], nextCursor: null});

            service.loadMore(CHANNEL);
            ctrl.verify();
        });

        it('coalesces a second loadMore while the first is still in the air', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl, {expenses: [expense()], nextCursor: 'cursor_1'});

            service.loadMore(CHANNEL);
            service.loadMore(CHANNEL);

            // One request, not two - a double-press must not fetch the same page twice.
            expectExpenses(ctrl).flush({items: [], nextCursor: null});
            ctrl.verify();
        });

        it('keeps the loaded pages and the cursor when a page fails, so it can be retried', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl, {expenses: [expense({id: 'expe_1'})], nextCursor: 'cursor_1'});

            service.loadMore(CHANNEL);
            expectExpenses(ctrl).flush(null, {status: 500, statusText: 'Server Error'});

            expect(service.stateFor(CHANNEL).expenses.map(e => e.id)).toEqual(['expe_1']);
            expect(service.stateFor(CHANNEL).nextCursor).toBe('cursor_1');
            expect(service.stateFor(CHANNEL).loadingMore).toBe(false);
            // The ledger on screen is still readable; only the page behind it is missing.
            expect(service.stateFor(CHANNEL).failed).toBe(false);
        });

        it('drops a page whose cursor a refresh invalidated, rather than leaving a hole', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl, {expenses: [expense({id: 'expe_9'})], nextCursor: 'cursor_1'});

            service.loadMore(CHANNEL);
            const stalePage = expectExpenses(ctrl);

            // The whole ledger is re-read underneath it and lands first.
            service.refresh(CHANNEL);
            answerLoad(ctrl, {expenses: [expense({id: 'expe_9'})], nextCursor: 'cursor_fresh'});

            stalePage.flush({
                items: [expense({id: 'expe_1', occurredAt: '2026-06-01T00:00:00Z'})],
                nextCursor: 'cursor_2',
            });

            // The page's rows sat behind a page the refresh discarded; taking them would skip
            // whatever is between, and its cursor would then point past the gap forever.
            expect(service.stateFor(CHANNEL).expenses.map(e => e.id)).toEqual(['expe_9']);
            expect(service.stateFor(CHANNEL).nextCursor).toBe('cursor_fresh');
            expect(service.stateFor(CHANNEL).loadingMore).toBe(false);
        });

        it('does not let a page revert an expense the socket updated while it was in flight', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl, {expenses: [expense({id: 'expe_1'})], nextCursor: 'cursor_1'});

            service.loadMore(CHANNEL);
            const page = expectExpenses(ctrl);

            hubHandlers.get('guild.ExpenseUpdated')!({
                guildId: 'gild_1',
                channelId: CHANNEL,
                expense: expense({id: 'expe_1', description: 'Coop, corrected'}),
            });
            answerBalances(ctrl);

            page.flush({items: [expense({id: 'expe_1', description: 'Coop'})], nextCursor: null});

            expect(service.stateFor(CHANNEL).expenses[0].description).toBe('Coop, corrected');
        });
    });

    describe('balances', () => {
        it('keeps what the server said and never recomputes it from the expenses', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            // 1000 across three: the server's remainder rule, which the client must not re-derive.
            answerLoad(ctrl, {
                expenses: [expense({
                    amountMinor: 1000,
                    shares: [
                        {userId: 'user_anna', shareValue: 0, amountMinor: 334},
                        {userId: 'user_marco', shareValue: 0, amountMinor: 333},
                        {userId: 'user_lea', shareValue: 0, amountMinor: 333},
                    ],
                })],
                balances: [
                    {userId: 'user_anna', netMinor: 666},
                    {userId: 'user_marco', netMinor: -333},
                    {userId: 'user_lea', netMinor: -333},
                ],
            });

            const balances = service.stateFor(CHANNEL).balances;
            expect(balances.reduce((sum, b) => sum + b.netMinor, 0)).toBe(0);
            expect(balances.find(b => b.userId === 'user_anna')?.netMinor).toBe(666);
        });

        it('reads an empty balance array as a settled house, not as missing data', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl, {expenses: [expense()], balances: []});
            expect(service.stateFor(CHANNEL).balances).toEqual([]);
            expect(service.stateFor(CHANNEL).loaded).toBe(true);
        });

        it('keeps the balances when only the settle suggestion fails', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            expectExpenses(ctrl).flush({items: [], nextCursor: null});
            ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/ledger/config`).flush({channelId: CHANNEL, currency: 'CHF'});
            ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/ledger/balances`)
                .flush([{userId: 'user_anna', netMinor: 500}]);
            ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/ledger/settle-suggestion`)
                .flush(null, {status: 500, statusText: 'Server Error'});

            expect(service.stateFor(CHANNEL).balances.length).toBe(1);
        });
    });

    describe('realtime', () => {
        it('re-fetches balances after an expense is created, and adds the row', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl);

            hubHandlers.get('guild.ExpenseCreated')!({
                guildId: 'gild_1',
                channelId: CHANNEL,
                expense: expense({id: 'expe_2'}),
            });

            expect(service.stateFor(CHANNEL).expenses.map(e => e.id)).toEqual(['expe_2']);
            answerBalances(ctrl, [{userId: 'user_anna', netMinor: 667}]);
            expect(service.stateFor(CHANNEL).balances[0].netMinor).toBe(667);
            ctrl.verify();
        });

        it('replaces rather than duplicates on an update, and re-fetches balances', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl, {expenses: [expense()]});

            hubHandlers.get('guild.ExpenseUpdated')!({
                guildId: 'gild_1',
                channelId: CHANNEL,
                expense: expense({description: 'Coop', amountMinor: 2000}),
            });

            expect(service.stateFor(CHANNEL).expenses.length).toBe(1);
            expect(service.stateFor(CHANNEL).expenses[0].description).toBe('Coop');
            answerBalances(ctrl);
        });

        it('removes the row on a delete, and re-fetches balances', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl, {expenses: [expense()]});

            hubHandlers.get('guild.ExpenseDeleted')!({
                guildId: 'gild_1',
                channelId: CHANNEL,
                expenseId: 'expe_1',
            });

            expect(service.stateFor(CHANNEL).expenses).toEqual([]);
            answerBalances(ctrl);
        });

        it('re-fetches balances on a settlement, which touches no expense at all', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl, {expenses: [expense()], balances: [{userId: 'user_anna', netMinor: 334}]});

            hubHandlers.get('guild.SettlementRecorded')!({
                guildId: 'gild_1',
                channelId: CHANNEL,
                settlement: settlement(),
            });

            // The expense list is untouched - which is exactly why the balance cannot be derived
            // from it and has to be asked for again.
            expect(service.stateFor(CHANNEL).expenses.length).toBe(1);
            expect(service.stateFor(CHANNEL).recentSettlements[0].id).toBe('sett_1');
            answerBalances(ctrl, []);
            expect(service.stateFor(CHANNEL).balances).toEqual([]);
        });

        it('ignores events for a channel nobody has opened', () => {
            const {service, ctrl} = setup();
            hubHandlers.get('guild.ExpenseCreated')!({
                guildId: 'gild_1',
                channelId: 'chan_other',
                expense: expense({channelId: 'chan_other'}),
            });
            expect(service.stateFor('chan_other').expenses).toEqual([]);
            // No fetch either: a guild with six ledgers must not fire six balance reads per event.
            ctrl.verify();
        });

        it('coalesces a burst into one round-trip and then exactly one more', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl);

            const created = hubHandlers.get('guild.ExpenseCreated')!;
            created({guildId: 'gild_1', channelId: CHANNEL, expense: expense({id: 'expe_a'})});
            created({guildId: 'gild_1', channelId: CHANNEL, expense: expense({id: 'expe_b'})});
            created({guildId: 'gild_1', channelId: CHANNEL, expense: expense({id: 'expe_c'})});

            // Three events, one flight: the second and third collapse into a single follow-up.
            answerBalances(ctrl, [{userId: 'user_anna', netMinor: 100}]);
            answerBalances(ctrl, [{userId: 'user_anna', netMinor: 300}]);

            expect(service.stateFor(CHANNEL).balances[0].netMinor).toBe(300);
            expect(service.stateFor(CHANNEL).expenses.length).toBe(3);
            ctrl.verify();
        });
    });

    describe('writes', () => {
        it('posts an equal split over an empty shares array for the whole guild', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl);

            service.addExpense(CHANNEL, {
                description: 'Rent',
                amountMinor: 180000,
                splitKind: ExpenseSplitKind.Equal,
                shares: [],
            }).subscribe();

            const req = ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/expenses`);
            expect(req.request.method).toBe('POST');
            expect(req.request.body.amountMinor).toBe(180000);
            expect(req.request.body.splitKind).toBe('Equal');
            expect(req.request.body.shares).toEqual([]);
            req.flush(expense({id: 'expe_rent', amountMinor: 180000}));

            expect(service.stateFor(CHANNEL).expenses.some(e => e.id === 'expe_rent')).toBe(true);
            answerBalances(ctrl);
        });

        it('edits and deletes through the expense-scoped routes', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl, {expenses: [expense()]});

            service.editExpense(CHANNEL, 'expe_1', {description: 'Coop'}).subscribe();
            const patch = ctrl.expectOne(`${GUILD}/expenses/expe_1`);
            expect(patch.request.method).toBe('PATCH');
            patch.flush(expense({description: 'Coop'}));
            answerBalances(ctrl);

            service.removeExpense(CHANNEL, 'expe_1').subscribe();
            const del = ctrl.expectOne(`${GUILD}/expenses/expe_1`);
            expect(del.request.method).toBe('DELETE');
            del.flush(null);
            expect(service.stateFor(CHANNEL).expenses).toEqual([]);
            answerBalances(ctrl);
        });

        it('applies the socket echo of an expense it just posted without duplicating it', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl);

            service.addExpense(CHANNEL, {
                description: 'Migros',
                amountMinor: 1000,
                splitKind: ExpenseSplitKind.Equal,
            }).subscribe();
            ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/expenses`).flush(expense());
            answerBalances(ctrl);

            hubHandlers.get('guild.ExpenseCreated')!({guildId: 'gild_1', channelId: CHANNEL, expense: expense()});
            expect(service.stateFor(CHANNEL).expenses.length).toBe(1);
            answerBalances(ctrl);
        });

        it('records a settlement in minor units and re-reads the balances', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl, {balances: [{userId: 'user_anna', netMinor: 334}]});

            service.recordSettlement(CHANNEL, {
                fromUserId: 'user_marco',
                toUserId: 'user_anna',
                amountMinor: 334,
            }).subscribe();

            const req = ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/ledger/settlements`);
            expect(req.request.method).toBe('POST');
            expect(req.request.body.amountMinor).toBe(334);
            req.flush(settlement());

            answerBalances(ctrl, []);
            expect(service.stateFor(CHANNEL).balances).toEqual([]);
        });

        it('writes the currency through the config route and relabels nothing else', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl, {expenses: [expense({amountMinor: 1234})]});

            service.saveConfig(CHANNEL, {currency: 'EUR'}).subscribe();
            const req = ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/ledger/config`);
            expect(req.request.method).toBe('PUT');
            req.flush({channelId: CHANNEL, currency: 'EUR'});

            expect(service.currencyFor(CHANNEL)).toBe('EUR');
            // The stored integer is untouched: 1234 rappen became 1234 cents, which is the whole
            // reason changing this needs a confirmation dialog.
            expect(service.stateFor(CHANNEL).expenses[0].amountMinor).toBe(1234);
        });
    });

    // ── Wire shapes ──────────────────────────────────────────────────────────
    // Asserted against `CreateExpenseDto`, `ExpenseShareDto`, `CreateSettlementDto` and
    // `UpdateLedgerConfigDto` rather than against what the client happens to build - all four were
    // written from inference before the request DTOs were readable.

    describe('request bodies', () => {
        it('posts an Equal split as an empty shares array, which means everyone in the guild', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl);

            service.addExpense(CHANNEL, {
                description: 'Rent',
                amountMinor: 180000,
                splitKind: ExpenseSplitKind.Equal,
                shares: [],
            }).subscribe();

            const req = ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/expenses`);
            // No payerUserId and no occurredAt: both are nullable server-side and both default to
            // "the caller, now". Sending nulls would say the same thing at more length; sending an
            // explicit payer would need ManageLedger.
            expect(wireBody(req.request.body)).toEqual({
                description: 'Rent',
                amountMinor: 180000,
                splitKind: 'Equal',
                shares: [],
            });
            req.flush(expense({id: 'expe_rent', amountMinor: 180000}));
            answerBalances(ctrl);
        });

        it('posts a Shares split as weights, never as per-person amounts', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl);

            service.addExpense(CHANNEL, {
                description: 'Internet',
                amountMinor: 6000,
                payerUserId: 'user_anna',
                occurredAt: '2026-08-01T12:00:00.000Z',
                splitKind: ExpenseSplitKind.Shares,
                shares: [
                    {userId: 'user_anna', shareValue: 2},
                    {userId: 'user_marco', shareValue: 1},
                ],
            }).subscribe();

            const req = ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/expenses`);
            // `shareValue` is a weight - "Anna counts double, she has the big room" - and there is
            // deliberately no `amountMinor` on a request share. Naming per-person amounts would be
            // an Exact split, which this client cannot express: the server distributes the
            // remainder (6000 over 2:1 is 4000/2000) and a client that guessed it would eventually
            // hand the odd rappen to a different flatmate and be rejected for a total that no
            // longer adds up.
            expect(wireBody(req.request.body)).toEqual({
                description: 'Internet',
                amountMinor: 6000,
                payerUserId: 'user_anna',
                occurredAt: '2026-08-01T12:00:00.000Z',
                splitKind: 'Shares',
                shares: [
                    {userId: 'user_anna', shareValue: 2},
                    {userId: 'user_marco', shareValue: 1},
                ],
            });
            req.flush(expense({splitKind: ExpenseSplitKind.Shares}));
            answerBalances(ctrl);
        });

        it('posts a settlement as CreateSettlementDto, with settledAt omitted for "just now"', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl);

            service.recordSettlement(CHANNEL, {
                fromUserId: 'user_marco',
                toUserId: 'user_anna',
                amountMinor: 334,
            }).subscribe();

            const req = ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/ledger/settlements`);
            expect(req.request.method).toBe('POST');
            expect(wireBody(req.request.body)).toEqual({
                fromUserId: 'user_marco',
                toUserId: 'user_anna',
                amountMinor: 334,
            });
            req.flush(settlement());
            answerBalances(ctrl);
        });

        it('puts the currency on its own - the config body has exactly one field', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            answerLoad(ctrl);

            service.saveConfig(CHANNEL, {currency: 'EUR'}).subscribe();

            const req = ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/ledger/config`);
            expect(req.request.method).toBe('PUT');
            // `UpdateLedgerConfigDto` is `{Currency}` and nothing else. A channelId in here would
            // be ignored, but it would also imply the route's own id was in question.
            expect(wireBody(req.request.body)).toEqual({currency: 'EUR'});
            req.flush({channelId: CHANNEL, currency: 'EUR'});
        });
    });
});

describe('normalizeCurrencyCode', () => {
    it('upper-cases and trims, exactly as UpdateConfigAsync does before validating', () => {
        expect(normalizeCurrencyCode(' chf ')).toBe('CHF');
        expect(normalizeCurrencyCode('EUR')).toBe('EUR');
    });

    it('rejects everything the server would answer 400 for', () => {
        // Three ASCII letters, no more and no less - the server checks IsAsciiLetterUpper after
        // upper-casing, so digits and accented letters are out however they are typed.
        expect(normalizeCurrencyCode('CH')).toBeNull();
        expect(normalizeCurrencyCode('CHFR')).toBeNull();
        expect(normalizeCurrencyCode('CH1')).toBeNull();
        expect(normalizeCurrencyCode('CHÉ')).toBeNull();
        expect(normalizeCurrencyCode('')).toBeNull();
    });
});
