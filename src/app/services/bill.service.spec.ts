import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {Subject} from 'rxjs';
import {BillService} from './bill.service';
import {ApiConfigService} from './api-config.service';
import {LedgerService} from './ledger.service';
import {RealtimeConnectionService} from './realtime-connection.service';
import {BillOccurrence, BillStatus, RecurrenceUnit, RecurringExpense} from '../dtos/response/bill.dto';
import {ExpenseCategory, ExpenseSplitKind} from '../dtos/response/ledger.dto';

const BASE = 'https://api.test.example';
const GUILD = `${BASE}/api/v1/guild`;
const CHANNEL = 'chan_ledger';
const GUILD_ID = 'gild_1';

const SCHEDULES_URL = `${GUILD}/channels/${CHANNEL}/recurring-expenses`;
const BILLS_URL = `${GUILD}/channels/${CHANNEL}/bills`;

/** Streams and handlers the module registered on the fake hub, so a test can fire a server event. */
let hubHandlers: Map<string, Subject<any>>;
/** Every registration in order, so the "registered exactly once" rule can be asserted. */
let registrations: string[];
/** Channels the ledger was told to re-read, which is the only thing posting a bill owes it. */
let ledgerRefreshes: string[];

function subjectFor(event: string): Subject<any> {
    let subject = hubHandlers.get(event);
    if (!subject) {
        subject = new Subject<any>();
        hubHandlers.set(event, subject);
    }
    return subject;
}

function setup() {
    hubHandlers = new Map();
    registrations = [];
    ledgerRefreshes = [];

    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: LedgerService, useValue: {refresh: (id: string) => ledgerRefreshes.push(id)}},
            {
                provide: RealtimeConnectionService,
                useValue: {
                    on: (event: string, handler: (payload: any) => void) => {
                        registrations.push(event);
                        subjectFor(event).subscribe(handler);
                    },
                    stream: (event: string) => {
                        registrations.push(event);
                        return subjectFor(event).asObservable();
                    },
                    off: () => undefined,
                },
            },
        ],
    });

    return {
        service: TestBed.inject(BillService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

function schedule(overrides: Partial<RecurringExpense> = {}): RecurringExpense {
    return {
        id: 'rexp_1',
        channelId: CHANNEL,
        description: 'Rent',
        amountMinor: 85000,
        currency: 'CHF',
        payerUserId: 'user_1',
        splitKind: ExpenseSplitKind.Equal,
        category: ExpenseCategory.Rent,
        recurrenceUnit: RecurrenceUnit.Month,
        recurrenceInterval: 1,
        anchorAt: '2026-01-01T00:00:00Z',
        nextDueAt: '2026-09-01T00:00:00Z',
        leadDays: 3,
        autoPost: false,
        isPaused: false,
        createdByUserId: 'user_1',
        shares: [],
        ...overrides,
    };
}

function bill(overrides: Partial<BillOccurrence> = {}): BillOccurrence {
    return {
        id: 'bill_1',
        recurringExpenseId: 'rexp_1',
        channelId: CHANNEL,
        description: 'Rent',
        dueAt: '2026-09-01T00:00:00Z',
        amountMinor: 85000,
        currency: 'CHF',
        status: BillStatus.Pending,
        expenseId: null,
        postedByUserId: null,
        skippedByUserId: null,
        skipReason: null,
        needsAmount: false,
        isOverdue: false,
        ...overrides,
    };
}

/** Opens one ledger channel and answers both halves of the first load. */
function load(
    service: BillService,
    ctrl: HttpTestingController,
    schedules: RecurringExpense[],
    bills: BillOccurrence[],
) {
    service.loadFor(CHANNEL);
    ctrl.expectOne(SCHEDULES_URL).flush(schedules);
    ctrl.expectOne(BILLS_URL).flush(bills);
}

function fire(event: string, payload: unknown) {
    const subject = hubHandlers.get(event);
    if (!subject) throw new Error(`no handler registered for ${event}`);
    subject.next(payload);
}

describe('BillService', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    describe('realtime registration', () => {
        it('registers the five bill events exactly once each', () => {
            setup();
            expect(registrations).toEqual([
                'guild.RecurringExpenseCreated',
                'guild.RecurringExpenseUpdated',
                'guild.RecurringExpenseDeleted',
                'guild.BillOccurrenceCreated',
                'guild.BillOccurrenceUpdated',
            ]);
        });

        // Posting a bill writes an expense, but the expense events belong to the ledger next door.
        it('does not register the ledger expense events', () => {
            setup();
            expect(registrations).not.toContain('guild.ExpenseCreated');
        });
    });

    describe('loading', () => {
        it('fetches both halves once per channel however often loadFor is called', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [schedule()], [bill()]);

            service.loadFor(CHANNEL);
            ctrl.expectNone(SCHEDULES_URL);
            ctrl.expectNone(BILLS_URL);

            expect(service.stateFor(CHANNEL).schedules.length).toBe(1);
            expect(service.stateFor(CHANNEL).bills.length).toBe(1);
            expect(service.stateFor(CHANNEL).loaded).toBe(true);
            expect(service.stateFor(CHANNEL).loading).toBe(false);
        });

        it('answers a channel nobody has opened with the empty state', () => {
            const {service} = setup();
            const state = service.stateFor('chan_other');
            expect(state.schedules).toEqual([]);
            expect(state.bills).toEqual([]);
            expect(state.loaded).toBe(false);
            expect(state.failed).toBe(false);
        });

        it('orders bills soonest first, the opposite of the expense list', () => {
            const {service, ctrl} = setup();
            load(
                service,
                ctrl,
                [],
                [
                    bill({id: 'late', dueAt: '2026-10-01T00:00:00Z'}),
                    bill({id: 'soon', dueAt: '2026-09-01T00:00:00Z'}),
                ],
            );
            expect(service.stateFor(CHANNEL).bills.map(b => b.id)).toEqual(['soon', 'late']);
        });

        it('truncates a fractional amount and keeps a varying one null', () => {
            const {service, ctrl} = setup();
            load(
                service,
                ctrl,
                [schedule({amountMinor: null})],
                [bill({amountMinor: 1250.4 as number, needsAmount: false})],
            );
            expect(service.stateFor(CHANNEL).schedules[0].amountMinor).toBeNull();
            expect(service.stateFor(CHANNEL).bills[0].amountMinor).toBe(1250);
        });

        it('keeps the bills board when only the schedule fetch fails', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            ctrl.expectOne(SCHEDULES_URL).flush('nope', {status: 500, statusText: 'Server Error'});
            ctrl.expectOne(BILLS_URL).flush([bill()]);

            expect(service.stateFor(CHANNEL).bills.length).toBe(1);
            expect(service.stateFor(CHANNEL).schedules).toEqual([]);
            expect(service.stateFor(CHANNEL).failed).toBe(false);
        });

        it('flags the channel failed only when both halves fail', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            ctrl.expectOne(SCHEDULES_URL).flush('nope', {status: 500, statusText: 'Server Error'});
            ctrl.expectOne(BILLS_URL).flush('nope', {status: 500, statusText: 'Server Error'});

            expect(service.stateFor(CHANNEL).failed).toBe(true);
            expect(service.stateFor(CHANNEL).forbidden).toBe(false);
            expect(service.stateFor(CHANNEL).loading).toBe(false);
        });

        // A 403 here usually means the guild has no Ledger module, so the panel renders nothing
        // rather than a denial, and `failed` must stay off or it would say the wrong thing.
        it('reports a 403 as forbidden rather than failed', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            ctrl.expectOne(SCHEDULES_URL).flush('nope', {status: 403, statusText: 'Forbidden'});
            ctrl.expectOne(BILLS_URL).flush('nope', {status: 403, statusText: 'Forbidden'});

            expect(service.stateFor(CHANNEL).forbidden).toBe(true);
            expect(service.stateFor(CHANNEL).failed).toBe(false);
        });

        it('re-reads both halves on refresh', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [], []);
            service.refresh(CHANNEL);
            ctrl.expectOne(SCHEDULES_URL).flush([schedule()]);
            ctrl.expectOne(BILLS_URL).flush([bill()]);
            expect(service.stateFor(CHANNEL).schedules.length).toBe(1);
        });
    });

    describe('reads', () => {
        it('leaves posted and skipped periods off the upcoming board', () => {
            const {service, ctrl} = setup();
            load(
                service,
                ctrl,
                [],
                [
                    bill({id: 'due', dueAt: '2026-09-01T00:00:00Z'}),
                    bill({
                        id: 'paid',
                        dueAt: '2026-08-01T00:00:00Z',
                        status: BillStatus.Posted,
                        expenseId: 'exp_1',
                    }),
                    bill({id: 'waived', dueAt: '2026-07-01T00:00:00Z', status: BillStatus.Skipped}),
                ],
            );

            expect(service.upcomingFor(CHANNEL).map(b => b.id)).toEqual(['due']);
            expect(service.stateFor(CHANNEL).bills.length).toBe(3);
        });

        it('resolves the template a period came from, and nothing for an unknown one', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [schedule()], [bill()]);
            expect(service.scheduleFor(CHANNEL, 'rexp_1')?.payerUserId).toBe('user_1');
            expect(service.scheduleFor(CHANNEL, 'rexp_missing')).toBeNull();
        });
    });

    describe('schedule writes', () => {
        it('applies the created schedule without waiting for the realtime event', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [], []);

            service
                .addSchedule(CHANNEL, {
                    description: 'Internet',
                    splitKind: ExpenseSplitKind.Equal,
                    recurrenceUnit: RecurrenceUnit.Month,
                    recurrenceInterval: 1,
                })
                .subscribe();
            ctrl.expectOne(SCHEDULES_URL).flush(schedule({id: 'rexp_2', description: 'Internet'}));

            expect(service.stateFor(CHANNEL).schedules.map(s => s.id)).toEqual(['rexp_2']);
        });

        // An edit moves the pending periods rather than regenerating them, and a shortened
        // interval can drop some with no event of its own, so the board has to be re-read.
        it('re-reads the bills board after an edit', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [schedule()], [bill()]);

            service.editSchedule(CHANNEL, 'rexp_1', {description: 'Rent (new)'}).subscribe();
            ctrl.expectOne(`${GUILD}/recurring-expenses/rexp_1`).flush(schedule({description: 'Rent (new)'}));
            ctrl.expectOne(BILLS_URL).flush([bill({dueAt: '2026-09-05T00:00:00Z'})]);

            expect(service.stateFor(CHANNEL).schedules[0].description).toBe('Rent (new)');
            expect(service.stateFor(CHANNEL).bills[0].dueAt).toBe('2026-09-05T00:00:00Z');
        });

        it('drops the schedule and its pending periods on delete, keeping the posted ones', () => {
            const {service, ctrl} = setup();
            load(
                service,
                ctrl,
                [schedule()],
                [
                    bill({id: 'pending'}),
                    bill({id: 'paid', status: BillStatus.Posted, dueAt: '2026-08-01T00:00:00Z'}),
                    bill({id: 'other', recurringExpenseId: 'rexp_9', dueAt: '2026-10-01T00:00:00Z'}),
                ],
            );

            service.removeSchedule(CHANNEL, 'rexp_1').subscribe();
            ctrl.expectOne(`${GUILD}/recurring-expenses/rexp_1`).flush(null);

            expect(service.stateFor(CHANNEL).schedules).toEqual([]);
            expect(service.stateFor(CHANNEL).bills.map(b => b.id)).toEqual(['paid', 'other']);
        });

        it('orders schedules by next due date', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [schedule({id: 'rexp_1', nextDueAt: '2026-09-10T00:00:00Z'})], []);

            fire('guild.RecurringExpenseCreated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                recurringExpense: schedule({id: 'rexp_2', nextDueAt: '2026-09-02T00:00:00Z'}),
            });

            expect(service.stateFor(CHANNEL).schedules.map(s => s.id)).toEqual(['rexp_2', 'rexp_1']);
        });
    });

    describe('bill writes', () => {
        // The bill's own row arrives as an event, but the expense it became is the ledger's and
        // nothing over there knows a bill was posted.
        it('re-reads the board and invalidates the ledger when a bill is posted', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [], [bill()]);

            service.postBill(CHANNEL, 'bill_1', {amountMinor: 85000}).subscribe();
            ctrl.expectOne(`${GUILD}/bills/bill_1/post`).flush({id: 'exp_1'});
            ctrl.expectOne(BILLS_URL).flush([bill({status: BillStatus.Posted, expenseId: 'exp_1'})]);

            expect(ledgerRefreshes).toEqual([CHANNEL]);
            expect(service.upcomingFor(CHANNEL)).toEqual([]);
        });

        it('applies the skipped period from the response', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [], [bill()]);

            service.skipBill(CHANNEL, 'bill_1', {reason: 'away'}).subscribe();
            ctrl.expectOne(`${GUILD}/bills/bill_1/skip`).flush(
                bill({status: BillStatus.Skipped, skipReason: 'away'}),
            );

            expect(service.upcomingFor(CHANNEL)).toEqual([]);
            expect(service.stateFor(CHANNEL).bills[0].skipReason).toBe('away');
        });
    });

    describe('realtime events', () => {
        it('adds a created period to an open channel', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [], []);
            fire('guild.BillOccurrenceCreated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                bill: bill({id: 'new'}),
            });
            expect(service.upcomingFor(CHANNEL).map(b => b.id)).toEqual(['new']);
        });

        it('ignores events for a channel nobody has opened rather than seeding a partial board', () => {
            const {service} = setup();
            fire('guild.BillOccurrenceCreated', {
                guildId: GUILD_ID,
                channelId: 'chan_other',
                bill: bill({channelId: 'chan_other'}),
            });
            fire('guild.RecurringExpenseCreated', {
                guildId: GUILD_ID,
                channelId: 'chan_other',
                recurringExpense: schedule({channelId: 'chan_other'}),
            });

            expect(service.stateFor('chan_other').bills).toEqual([]);
            expect(service.stateFor('chan_other').schedules).toEqual([]);
            expect(service.stateFor('chan_other').loaded).toBe(false);
        });

        // The row that needs paying twice is the failure that matters, so a re-delivered create
        // has to land as an upsert.
        it('treats a re-delivered period create as an upsert', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [], [bill()]);
            fire('guild.BillOccurrenceCreated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                bill: bill({amountMinor: 90000}),
            });

            expect(service.stateFor(CHANNEL).bills.length).toBe(1);
            expect(service.stateFor(CHANNEL).bills[0].amountMinor).toBe(90000);
        });

        it('takes a period off the upcoming board when it is posted elsewhere', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [], [bill()]);
            fire('guild.BillOccurrenceUpdated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                bill: bill({status: BillStatus.Posted, expenseId: 'exp_1'}),
            });

            expect(service.upcomingFor(CHANNEL)).toEqual([]);
            expect(service.stateFor(CHANNEL).bills.length).toBe(1);
        });

        // A write can reach a channel whose board was never fetched, and the events that follow it
        // have to land on that row rather than being dropped as "nobody opened this channel".
        it('keeps listening on a channel a write reached before any load', () => {
            const {service, ctrl} = setup();

            service.skipBill('chan_unopened', 'bill_9', {}).subscribe();
            ctrl.expectOne(`${GUILD}/bills/bill_9/skip`).flush(
                bill({id: 'bill_9', channelId: 'chan_unopened', status: BillStatus.Skipped}),
            );

            fire('guild.BillOccurrenceCreated', {
                guildId: GUILD_ID,
                channelId: 'chan_unopened',
                bill: bill({id: 'bill_10', channelId: 'chan_unopened', dueAt: '2026-10-01T00:00:00Z'}),
            });

            expect(service.stateFor('chan_unopened').bills.map(b => b.id)).toEqual(['bill_9', 'bill_10']);
        });

        it('patches a schedule from an update event', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [schedule()], []);
            fire('guild.RecurringExpenseUpdated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                recurringExpense: schedule({isPaused: true}),
            });

            expect(service.stateFor(CHANNEL).schedules.length).toBe(1);
            expect(service.stateFor(CHANNEL).schedules[0].isPaused).toBe(true);
        });

        it('drops the schedule and its outstanding periods when it is deleted elsewhere', () => {
            const {service, ctrl} = setup();
            load(
                service,
                ctrl,
                [schedule()],
                [bill({id: 'pending'}), bill({id: 'paid', status: BillStatus.Posted})],
            );

            fire('guild.RecurringExpenseDeleted', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                recurringExpenseId: 'rexp_1',
            });

            expect(service.stateFor(CHANNEL).schedules).toEqual([]);
            expect(service.stateFor(CHANNEL).bills.map(b => b.id)).toEqual(['paid']);
        });
    });
});
