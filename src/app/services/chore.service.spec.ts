import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ChoreService} from './chore.service';
import {ApiConfigService} from './api-config.service';
import {ProfileService} from './profile.service';
import {RealtimeConnectionService} from './realtime-connection.service';
import {NotificationService} from './notification.service';
import {TranslateService} from '@ngx-translate/core';
import {Chore, ChoreBalanceEntry, ChoreOccurrence, occurrenceStatus} from '../dtos/response/chore.dto';

const BASE = 'https://api.test.example';
const G = `${BASE}/api/v1/guild`;
const CHANNEL = 'chan_1';

/**
 * The body as it reaches the server, not as it was handed to HttpClient.
 *
 * <p>The JSON round-trip drops `undefined` keys, which is exactly the distinction these assertions
 * are about: "omitted, so the server's default applies" and "sent as null" are different requests
 * and only one of them is visible in the object HttpClient was handed.</p>
 */
function wireBody(body: unknown): unknown {
    return JSON.parse(JSON.stringify(body));
}

/** Handlers registered on the fake hub, so a test can fire a server event by name. */
const hubHandlers = new Map<string, ((payload: never) => void)[]>();

function fire(event: string, payload: unknown): void {
    for (const handler of hubHandlers.get(event) ?? []) (handler as (p: unknown) => void)(payload);
}

function chore(overrides: Partial<Chore> = {}): Chore {
    return {
        id: 'chor_1',
        channelId: CHANNEL,
        title: 'Washing-up',
        description: null,
        intervalDays: 1,
        anchorAt: '2026-08-01T18:00:00.000Z',
        effortMinutes: 15,
        rotationRoleId: 'role_flatmates',
        fixedAssigneeUserId: null,
        graceHours: 12,
        isPaused: false,
        nextDueAt: '2026-08-04T18:00:00.000Z',
        ...overrides,
    };
}

function occurrence(overrides: Partial<ChoreOccurrence> = {}): ChoreOccurrence {
    return {
        id: 'occr_1',
        choreId: 'chor_1',
        channelId: CHANNEL,
        title: 'Washing-up',
        dueAt: '2026-08-03T18:00:00.000Z',
        assignedUserId: 'user_anna',
        effortMinutes: 15,
        completedAt: null,
        completedByUserId: null,
        skippedAt: null,
        isOverdue: false,
        ...overrides,
    };
}

/** Every OS notification the service raised, newest last. */
const notifications: {title: string; message: string; extra?: Record<string, string>}[] = [];

function setup() {
    hubHandlers.clear();
    notifications.length = 0;
    // Explicit, so one test that throws before its module is torn down does not turn every later
    // test in the file into "the test module has already been instantiated".
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: ProfileService, useValue: {ownProfile: signal({userId: 'user_ben'})}},
            {
                provide: RealtimeConnectionService,
                useValue: {
                    on: (event: string, handler: (payload: never) => void) => {
                        const existing = hubHandlers.get(event) ?? [];
                        hubHandlers.set(event, [...existing, handler]);
                    },
                },
            },
            {
                provide: NotificationService,
                useValue: {
                    createNotification: (params: {title: string; message: string; extra?: Record<string, string>}) => {
                        notifications.push(params);
                        return Promise.resolve();
                    },
                },
            },
            {provide: TranslateService, useValue: {instant: (key: string) => key}},
        ],
    });
    const service = TestBed.inject(ChoreService);
    const http = TestBed.inject(HttpTestingController);
    return {service, http};
}

/** Answers the three requests `loadFor` fires together. */
function flushLoad(
    http: HttpTestingController,
    chores: Chore[] = [chore()],
    occurrences: ChoreOccurrence[] = [occurrence()],
    balance: ChoreBalanceEntry[] = [],
): void {
    http.expectOne(r => r.url === `${G}/channels/${CHANNEL}/chores`).flush(chores);
    http.expectOne(r => r.url === `${G}/channels/${CHANNEL}/chores/occurrences`).flush(occurrences);
    http.expectOne(r => r.url === `${G}/channels/${CHANNEL}/chores/balance`).flush(balance);
}

function loaded(overrides: {
    chores?: Chore[];
    occurrences?: ChoreOccurrence[];
    balance?: ChoreBalanceEntry[];
} = {}) {
    const {service, http} = setup();
    service.loadFor(CHANNEL);
    flushLoad(http, overrides.chores, overrides.occurrences, overrides.balance);
    return {service, http};
}

function row(service: ChoreService, id = 'occr_1'): ChoreOccurrence {
    const found = service.stateFor(CHANNEL).occurrences.find(o => o.id === id);
    if (!found) throw new Error(`no occurrence ${id}`);
    return found;
}

afterEach(() => {
    vi.useRealTimers();
    TestBed.inject(HttpTestingController).verify();
});

describe('ChoreService realtime registration', () => {
    it('registers each of the five chore events exactly once', () => {
        setup();
        // `RealtimeConnectionService.on` does not deduplicate, so a second registration would
        // deliver every event twice - and a doubled occurrence event means two balance refetches
        // for one server-side change.
        for (const event of [
            'guild.ChoreCreated',
            'guild.ChoreUpdated',
            'guild.ChoreDeleted',
            'guild.ChoreOccurrenceCreated',
            'guild.ChoreOccurrenceUpdated',
            'guild.ChoreReminder',
        ]) {
            expect(hubHandlers.get(event)?.length).toBe(1);
        }
    });
});

describe('ChoreService guild.ChoreReminder', () => {
    function reminder(overrides: Record<string, unknown> = {}) {
        return {
            guildId: 'gild_1',
            channelId: CHANNEL,
            occurrenceId: 'occr_1',
            choreId: 'chor_1',
            title: 'Take the bins out',
            dueAt: '2026-08-03T18:00:00.000Z',
            ...overrides,
        };
    }

    it('notifies even when the board was never opened - that is the point of a reminder', () => {
        // No `loadFor`, so this channel is untracked and every other handler would drop the event.
        const {service} = setup();
        expect(service).toBeTruthy();

        fire('guild.ChoreReminder', reminder());

        expect(notifications.length).toBe(1);
        expect(notifications[0].message).toBe('Take the bins out');
    });

    it('carries the household push keys, so a click has what a deep-link needs', () => {
        setup();
        fire('guild.ChoreReminder', reminder());

        expect(notifications[0].extra).toEqual({
            type: 'household',
            kind: 'chore.due',
            targetId: 'occr_1',
            guildId: 'gild_1',
            channelId: CHANNEL,
        });
    });

    it('buzzes once per occurrence, so a reconnect redelivery is silent', () => {
        setup();
        fire('guild.ChoreReminder', reminder());
        fire('guild.ChoreReminder', reminder());

        expect(notifications.length).toBe(1);
    });

    it('still notifies for a different occurrence of the same chore', () => {
        setup();
        fire('guild.ChoreReminder', reminder());
        fire('guild.ChoreReminder', reminder({occurrenceId: 'occr_2'}));

        expect(notifications.length).toBe(2);
    });

    it('ignores a payload with no occurrence to point at rather than notifying about nothing', () => {
        setup();
        fire('guild.ChoreReminder', reminder({occurrenceId: undefined}));

        expect(notifications.length).toBe(0);
    });
});

describe('ChoreService loading', () => {
    it('flags a 403 separately from an ordinary failure', () => {
        const {service, http} = setup();
        service.loadFor(CHANNEL);
        http.expectOne(r => r.url === `${G}/channels/${CHANNEL}/chores`)
            .flush({}, {status: 403, statusText: 'Forbidden'});
        // The three reads go out as one forkJoin, so the first error tears the siblings down.
        // Draining them keeps `verify` about requests nobody answered.
        http.match(() => true);

        // A 403 here usually means the guild's Chores module is off, not that the caller lacks a
        // permission bit - the UI has to be able to say the right sentence.
        expect(service.stateFor(CHANNEL).forbidden).toBe(true);
        expect(service.stateFor(CHANNEL).error).toBe(true);
    });

    it('does not record a failed load as loaded, so a retry is not blocked by the TTL', () => {
        const {service, http} = setup();
        service.loadFor(CHANNEL);
        http.expectOne(r => r.url === `${G}/channels/${CHANNEL}/chores`)
            .flush({}, {status: 500, statusText: 'Server Error'});
        http.match(() => true);

        expect(service.stateFor(CHANNEL).loadedAt).toBe(0);
        service.loadFor(CHANNEL);
        flushLoad(http);
        expect(service.stateFor(CHANNEL).chores.length).toBe(1);
    });
});

describe('ChoreService guild.ChoreOccurrenceUpdated', () => {
    it('applies the full-snapshot shape sent by complete', () => {
        const {service} = loaded();

        fire('guild.ChoreOccurrenceUpdated', {
            guildId: 'gild_1',
            channelId: CHANNEL,
            occurrence: occurrence({
                completedAt: '2026-08-03T19:12:00.000Z',
                completedByUserId: 'user_ben',
            }),
        });

        expect(occurrenceStatus(row(service))).toBe('done');
        // The doer is not the assignee, and the row keeps both: the balance credits Anna.
        expect(row(service).completedByUserId).toBe('user_ben');
        expect(row(service).assignedUserId).toBe('user_anna');
    });

    it('applies a skip from the snapshot, which now carries the occurrence like the other verbs', () => {
        const {service} = loaded();

        fire('guild.ChoreOccurrenceUpdated', {
            guildId: 'gild_1',
            channelId: CHANNEL,
            occurrence: occurrence({skippedAt: '2026-08-03T19:12:00.000Z'}),
        });

        expect(occurrenceStatus(row(service))).toBe('skipped');
        expect(row(service).skippedAt).toBeTruthy();
        // Skipping is not completing.
        expect(row(service).completedAt).toBeNull();
        expect(row(service).completedByUserId).toBeNull();
    });

    it('ignores the retired skip marker instead of throwing inside the SignalR callback', () => {
        const {service} = loaded();

        // What a server that has not rolled forward still sends: an id and a flag, no occurrence.
        // A handler written against the snapshot alone dereferences `undefined.id` here, and the
        // throw takes every later handler for this event down with it.
        expect(() => fire('guild.ChoreOccurrenceUpdated', {
            guildId: 'gild_1',
            channelId: CHANNEL,
            occurrenceId: 'occr_1',
            skipped: true,
        })).not.toThrow();

        // The row is left as it was rather than half-patched; the next board load corrects it.
        expect(occurrenceStatus(row(service))).toBe('due');
    });

    it('does not refetch the balance on a skip - a skip credits nobody', () => {
        vi.useFakeTimers();
        const {service, http} = loaded();

        fire('guild.ChoreOccurrenceUpdated', {
            guildId: 'gild_1',
            channelId: CHANNEL,
            occurrence: occurrence({skippedAt: '2026-08-03T19:12:00.000Z'}),
        });
        vi.advanceTimersByTime(2000);

        http.expectNone(r => r.url === `${G}/channels/${CHANNEL}/chores/balance`);
        expect(occurrenceStatus(row(service))).toBe('skipped');
    });

    it('refetches the balance when a snapshot changes the completion', () => {
        vi.useFakeTimers();
        const {http} = loaded();

        fire('guild.ChoreOccurrenceUpdated', {
            guildId: 'gild_1',
            channelId: CHANNEL,
            occurrence: occurrence({completedAt: '2026-08-03T19:12:00.000Z', completedByUserId: 'user_anna'}),
        });
        vi.advanceTimersByTime(2000);

        http.expectOne(r => r.url === `${G}/channels/${CHANNEL}/chores/balance`).flush([]);
    });

    it('does not refetch the balance for a swap, which moves no minutes', () => {
        vi.useFakeTimers();
        const {service, http} = loaded();

        // Swap arrives through the same snapshot branch as complete; only the assignee moves.
        fire('guild.ChoreOccurrenceUpdated', {
            guildId: 'gild_1',
            channelId: CHANNEL,
            occurrence: occurrence({assignedUserId: 'user_ben'}),
        });
        vi.advanceTimersByTime(2000);

        http.expectNone(r => r.url === `${G}/channels/${CHANNEL}/chores/balance`);
        expect(row(service).assignedUserId).toBe('user_ben');
    });

    it('takes on a turn from outside the loaded window rather than dropping it', () => {
        // The snapshot is self-contained, so an update for a row this client never loaded is an
        // upsert and not a miss - which is what the marker shape could never do.
        const {service} = loaded();
        fire('guild.ChoreOccurrenceUpdated', {
            guildId: 'gild_1',
            channelId: CHANNEL,
            occurrence: occurrence({id: 'occr_unknown'}),
        });
        expect(service.stateFor(CHANNEL).occurrences.map(o => o.id)).toEqual(['occr_1', 'occr_unknown']);
    });

    it('drops events for a channel that was never opened', () => {
        const {service} = setup();
        fire('guild.ChoreOccurrenceCreated', {
            guildId: 'gild_1', channelId: 'chan_other', occurrence: occurrence({channelId: 'chan_other'}),
        });
        expect(service.stateFor('chan_other').occurrences.length).toBe(0);
    });
});

describe('ChoreService chore events', () => {
    it('upserts a created chore', () => {
        const {service} = loaded();
        fire('guild.ChoreCreated', {
            guildId: 'gild_1', channelId: CHANNEL, chore: chore({id: 'chor_2', title: 'Bins'}),
        });
        expect(service.stateFor(CHANNEL).chores.map(c => c.id)).toEqual(['chor_1', 'chor_2']);
    });

    it('replaces rather than duplicates on update', () => {
        const {service} = loaded();
        fire('guild.ChoreUpdated', {
            guildId: 'gild_1', channelId: CHANNEL, chore: chore({effortMinutes: 40}),
        });
        expect(service.stateFor(CHANNEL).chores.length).toBe(1);
        expect(service.stateFor(CHANNEL).chores[0].effortMinutes).toBe(40);
    });

    it('sweeps a deleted chore\'s occurrences, which the event does not enumerate', () => {
        const {service} = loaded({
            occurrences: [occurrence(), occurrence({id: 'occr_2', choreId: 'chor_other'})],
        });

        fire('guild.ChoreDeleted', {guildId: 'gild_1', channelId: CHANNEL, choreId: 'chor_1'});

        expect(service.stateFor(CHANNEL).chores.length).toBe(0);
        // Leaving them would strand rows that can no longer be completed, skipped or swapped.
        expect(service.stateFor(CHANNEL).occurrences.map(o => o.id)).toEqual(['occr_2']);
    });
});

describe('ChoreService verbs', () => {
    it('optimistically names the caller as the doer while leaving the assignee alone', () => {
        vi.useFakeTimers();
        const {service, http} = loaded();

        service.complete(row(service)).subscribe();

        // Before the response lands: Ben did Anna's washing-up, and the credit is still Anna's.
        expect(row(service).completedByUserId).toBe('user_ben');
        expect(row(service).assignedUserId).toBe('user_anna');
        expect(occurrenceStatus(row(service))).toBe('done');

        http.expectOne(`${G}/chore-occurrences/occr_1/complete`).flush(null);
        vi.advanceTimersByTime(2000);
        http.expectOne(r => r.url === `${G}/channels/${CHANNEL}/chores/balance`).flush([]);
    });

    it('clears any completion when skipping, so nothing downstream reads it as done', () => {
        const {service, http} = loaded({
            occurrences: [occurrence({completedAt: '2026-08-03T19:00:00.000Z', completedByUserId: 'user_ben'})],
        });

        service.skip(row(service)).subscribe();

        expect(occurrenceStatus(row(service))).toBe('skipped');
        expect(row(service).completedAt).toBeNull();

        http.expectOne(`${G}/chore-occurrences/occr_1/skip`).flush(null);
    });

    it('does not refetch the balance for a skip it issued itself', () => {
        vi.useFakeTimers();
        const {service, http} = loaded();

        service.skip(row(service)).subscribe();
        http.expectOne(`${G}/chore-occurrences/occr_1/skip`).flush(null);
        vi.advanceTimersByTime(2000);

        http.expectNone(r => r.url === `${G}/channels/${CHANNEL}/chores/balance`);
    });

    it('rolls an optimistic skip back when the request fails', () => {
        const {service, http} = loaded();
        const before = row(service);

        service.skip(before).subscribe({error: () => undefined});
        expect(occurrenceStatus(row(service))).toBe('skipped');

        http.expectOne(`${G}/chore-occurrences/occr_1/skip`)
            .flush({}, {status: 403, statusText: 'Forbidden'});

        expect(occurrenceStatus(row(service))).toBe('due');
        expect(row(service).skippedAt).toBeNull();
    });

    it('rolls an optimistic completion back when the request fails', () => {
        const {service, http} = loaded();

        service.complete(row(service)).subscribe({error: () => undefined});
        http.expectOne(`${G}/chore-occurrences/occr_1/complete`)
            .flush({}, {status: 500, statusText: 'Server Error'});

        expect(occurrenceStatus(row(service))).toBe('due');
        expect(row(service).completedByUserId).toBeNull();
    });

    it('does not guess who a swap lands on', () => {
        const {service, http} = loaded();

        service.swap(row(service)).subscribe();
        // Still Anna's until the server answers: guessing the lightest-loaded member from a
        // possibly stale balance would name the wrong flatmate.
        expect(row(service).assignedUserId).toBe('user_anna');

        http.expectOne(`${G}/chore-occurrences/occr_1/swap`)
            .flush(occurrence({assignedUserId: 'user_ben'}));
        expect(row(service).assignedUserId).toBe('user_ben');
    });

    it('surfaces the 400 from a swap with nobody else in the rotation', () => {
        const {service, http} = loaded();
        let status = 0;

        service.swap(row(service)).subscribe({error: err => status = err.status});
        http.expectOne(`${G}/chore-occurrences/occr_1/swap`)
            .flush({}, {status: 400, statusText: 'Bad Request'});

        expect(status).toBe(400);
        expect(row(service).assignedUserId).toBe('user_anna');
    });

    it('tolerates an empty 204 body from a verb and waits for the realtime echo', () => {
        vi.useFakeTimers();
        const {service, http} = loaded();

        service.complete(row(service)).subscribe();
        http.expectOne(`${G}/chore-occurrences/occr_1/complete`).flush(null, {status: 204, statusText: 'No Content'});
        vi.advanceTimersByTime(2000);
        http.expectOne(r => r.url === `${G}/channels/${CHANNEL}/chores/balance`).flush([]);

        // The optimistic row stands; the snapshot event replaces it when it arrives.
        expect(occurrenceStatus(row(service))).toBe('done');
    });
});

describe('ChoreService occurrence generation', () => {
    it('exposes no way to create an occurrence - the server generates them', () => {
        const {service} = loaded();
        // Guards the §4 rule against a well-meaning future addition: any client-side cadence
        // arithmetic disagrees with the rota within one interval.
        expect((service as unknown as Record<string, unknown>)['createOccurrence']).toBeUndefined();
    });

    it('adds a turn only when guild.ChoreOccurrenceCreated says so', () => {
        const {service} = loaded({occurrences: []});
        expect(service.stateFor(CHANNEL).occurrences.length).toBe(0);

        fire('guild.ChoreOccurrenceCreated', {
            guildId: 'gild_1', channelId: CHANNEL, occurrence: occurrence({id: 'occr_9'}),
        });

        expect(service.stateFor(CHANNEL).occurrences.map(o => o.id)).toEqual(['occr_9']);
    });
});

// ── Wire shapes ─────────────────────────────────────────────────────────────
// Asserted against `Guild.Application.Dtos.Request.CreateChoreDto` / `UpdateChoreDto`, which the
// module was originally written without.

describe('ChoreService request bodies', () => {
    it('posts a create carrying an anchor when one was picked', () => {
        const {service, http} = loaded();

        service.createChore(CHANNEL, {
            title: 'Bins',
            description: null,
            intervalDays: 7,
            anchorAt: '2026-08-04T07:00:00.000Z',
            effortMinutes: 10,
            graceHours: 24,
            rotationRoleId: 'role_flatmates',
            fixedAssigneeUserId: null,
        }).subscribe();

        const req = http.expectOne(`${G}/channels/${CHANNEL}/chores`);
        expect(req.request.method).toBe('POST');
        expect(wireBody(req.request.body)).toEqual({
            title: 'Bins',
            description: null,
            intervalDays: 7,
            anchorAt: '2026-08-04T07:00:00.000Z',
            effortMinutes: 10,
            graceHours: 24,
            rotationRoleId: 'role_flatmates',
            fixedAssigneeUserId: null,
        });
        req.flush(chore({id: 'chor_bins', title: 'Bins'}));
    });

    it('posts a create with no anchor at all, leaving the server to anchor it at now', () => {
        const {service, http} = loaded();

        // The three cadence fields are omitted too: CreateChoreDto defaults them to 7 / 15 / 24,
        // and a client that restated the defaults would keep restating them after they changed.
        service.createChore(CHANNEL, {
            title: 'Recycling',
            fixedAssigneeUserId: 'user_anna',
        }).subscribe();

        const req = http.expectOne(`${G}/channels/${CHANNEL}/chores`);
        expect(wireBody(req.request.body)).toEqual({
            title: 'Recycling',
            fixedAssigneeUserId: 'user_anna',
        });
        req.flush(chore({id: 'chor_recy', title: 'Recycling'}));
    });

    it('patches a pause as one field and nothing else', () => {
        const {service, http} = loaded();

        service.setPaused(CHANNEL, 'chor_1', true).subscribe();

        const req = http.expectOne(`${G}/chores/chor_1`);
        expect(req.request.method).toBe('PATCH');
        // Re-sending the title and cadence to flip a boolean would overwrite whatever a flatmate
        // changed in between - PATCH applies exactly what it is given.
        expect(wireBody(req.request.body)).toEqual({isPaused: true});
        req.flush(chore({isPaused: true}));

        expect(service.stateFor(CHANNEL).chores[0].isPaused).toBe(true);
    });

    it('patches an unpause the same way', () => {
        const {service, http} = loaded({chores: [chore({isPaused: true})]});

        service.setPaused(CHANNEL, 'chor_1', false).subscribe();

        const req = http.expectOne(`${G}/chores/chor_1`);
        expect(wireBody(req.request.body)).toEqual({isPaused: false});
        req.flush(chore({isPaused: false}));

        expect(service.stateFor(CHANNEL).chores[0].isPaused).toBe(false);
    });

    it('has no anchorAt to send on an update - UpdateChoreDto does not carry one', () => {
        const {service, http} = loaded();

        service.updateChore(CHANNEL, 'chor_1', {
            title: 'Washing-up (evenings)',
            intervalDays: 2,
            isPaused: false,
        }).subscribe();

        const req = http.expectOne(`${G}/chores/chor_1`);
        // A re-phase would move every turn already generated from the old anchor, so the server
        // simply has no field for it: an anchorAt here would be dropped in silence, which reads
        // from the dialog exactly like a re-phase that worked.
        expect(wireBody(req.request.body)).not.toHaveProperty('anchorAt');
        expect(wireBody(req.request.body)).toEqual({
            title: 'Washing-up (evenings)',
            intervalDays: 2,
            isPaused: false,
        });
        req.flush(chore({title: 'Washing-up (evenings)', intervalDays: 2}));
    });
});
