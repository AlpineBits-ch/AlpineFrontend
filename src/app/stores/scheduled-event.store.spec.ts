import {TestBed} from '@angular/core/testing';
import {Observable, of, Subject, throwError} from 'rxjs';
import {ScheduledEventStore} from './scheduled-event.store';
import {ScheduledEventService} from '../services/scheduled-event.service';
import {ScheduledEventDto, ScheduledEventStatus} from '../dtos/response/scheduled-event.dto';
import {CreateScheduledEventDto, UpdateScheduledEventDto} from '../dtos/request/scheduled-event.dto';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {FakeRealtimeConnection} from '../testing/fake-realtime-connection';

function event(id: string, overrides: Partial<ScheduledEventDto> = {}): ScheduledEventDto {
    return {
        id,
        guildId: 'g1',
        creatorUserId: 'u1',
        title: `Event ${id}`,
        description: null,
        startsAt: '2026-08-01T00:00:00Z',
        endsAt: null,
        location: null,
        voiceChannelId: null,
        status: ScheduledEventStatus.Scheduled,
        interestedCount: 0,
        isInterested: false,
        ...overrides,
    };
}

/** Subject-backed fake so response timing is fully controlled and requests can be counted. */
class FakeScheduledEventService {
    listPending: Subject<ScheduledEventDto[]>[] = [];
    interestPending: Subject<void>[] = [];

    list(_guildId: string): Observable<ScheduledEventDto[]> {
        const subject = new Subject<ScheduledEventDto[]>();
        this.listPending.push(subject);
        return subject.asObservable();
    }

    get requestCount(): number {
        return this.listPending.length;
    }

    create(_guildId: string, dto: CreateScheduledEventDto): Observable<ScheduledEventDto> {
        return of(event('created', dto));
    }

    update(eventId: string, dto: UpdateScheduledEventDto): Observable<ScheduledEventDto> {
        return of(event(eventId, dto));
    }

    /** Overridable per-test (e.g. `throwError(...)`) to exercise the error path. */
    cancelResult: Observable<void> = of(undefined);

    cancel(_eventId: string): Observable<void> {
        return this.cancelResult;
    }

    markInterested(_eventId: string): Observable<void> {
        const subject = new Subject<void>();
        this.interestPending.push(subject);
        return subject.asObservable();
    }

    removeInterest(_eventId: string): Observable<void> {
        const subject = new Subject<void>();
        this.interestPending.push(subject);
        return subject.asObservable();
    }
}

function setup() {
    const api = new FakeScheduledEventService();
    const ws = new FakeRealtimeConnection();
    TestBed.configureTestingModule({
        providers: [
            {provide: ScheduledEventService, useValue: api},
            {provide: RealtimeConnectionService, useValue: ws},
        ],
    });
    return {api, ws, store: TestBed.inject(ScheduledEventStore)};
}

describe('ScheduledEventStore', () => {
    it('loadFor populates eventsForGuild from the service', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.listPending[0].next([event('e1'), event('e2')]);
        api.listPending[0].complete();

        expect(store.eventsForGuild('g1').map(e => e.id)).toEqual(['e1', 'e2']);
    });

    it('sorts eventsForGuild ascending by startsAt', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.listPending[0].next([
            event('later', {startsAt: '2026-09-01T00:00:00Z'}),
            event('earlier', {startsAt: '2026-08-01T00:00:00Z'}),
        ]);
        api.listPending[0].complete();

        expect(store.eventsForGuild('g1').map(e => e.id)).toEqual(['earlier', 'later']);
    });

    it('issues only one request for back-to-back loadFor calls while the first is in flight', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        store.loadFor('g1');
        store.loadFor('g1');

        expect(api.requestCount).toBe(1);
    });

    it('does not refetch once loaded', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.listPending[0].next([event('e1')]);
        api.listPending[0].complete();

        store.loadFor('g1');

        expect(api.requestCount).toBe(1);
    });

    it('clears loading and the loaded flag on error so a retry is possible', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.listPending[0].error(new Error('boom'));

        store.loadFor('g1');

        expect(api.requestCount).toBe(2);
    });

    it('refetches once the load is older than the staleness TTL', () => {
        const {api, store} = setup();
        const base = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(base);

        try {
            store.loadFor('g1');
            api.listPending[0].next([event('e1')]);
            api.listPending[0].complete();
            expect(api.requestCount).toBe(1);

            // Just inside the 2-minute TTL - still fresh.
            clock.mockReturnValue(base + 119_000);
            store.loadFor('g1');
            expect(api.requestCount).toBe(1);

            // Past the TTL - SignalR doesn't replay across a reconnect, so this is the only
            // thing standing between a missed realtime message and a permanently stale list.
            clock.mockReturnValue(base + 121_000);
            store.loadFor('g1');
            expect(api.requestCount).toBe(2);
        } finally {
            clock.mockRestore();
        }
    });

    it('issues the queued refetch when a realtime invalidation races an in-flight list request', () => {
        const {api, ws, store} = setup();

        // Panel opens - GET issued, no response yet.
        store.loadFor('g1');
        expect(api.requestCount).toBe(1);

        // Someone creates an event while the original request is still in flight.
        ws.emit('guild.EventCreated', {
            guildId: 'g1',
            eventId: 'e2',
            title: 'New',
            startsAt: '2026-08-05T00:00:00Z',
        });

        // The refetch is queued, not fired on top of the in-flight request.
        expect(api.requestCount).toBe(1);

        // The (pre-creation) original response lands - the follow-up must go out now,
        // rather than being swallowed and marking the guild loaded forever.
        api.listPending[0].next([event('e1')]);
        api.listPending[0].complete();
        expect(api.requestCount).toBe(2);

        api.listPending[1].next([event('e1'), event('e2')]);
        api.listPending[1].complete();
        expect(store.eventsForGuild('g1').map(e => e.id)).toEqual(['e1', 'e2']);
    });

    it('issues the queued refetch even when the racing in-flight request fails', () => {
        const {api, ws, store} = setup();

        store.loadFor('g1');
        ws.emit('guild.EventCreated', {
            guildId: 'g1',
            eventId: 'e2',
            title: 'New',
            startsAt: '2026-08-05T00:00:00Z',
        });
        api.listPending[0].error(new Error('boom'));

        expect(api.requestCount).toBe(2);
    });

    it('ignores realtime events for guilds that were never loaded', () => {
        const {api, ws, store} = setup();

        ws.emit('guild.EventCreated', {
            guildId: 'other',
            eventId: 'x',
            title: 'Elsewhere',
            startsAt: '2026-08-05T00:00:00Z',
        });

        // No GET for a guild nobody has opened, and no entities accumulated for it.
        expect(api.requestCount).toBe(0);
        expect(store.eventsForGuild('other')).toEqual([]);
    });

    it('records a load error that a successful retry clears', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.listPending[0].error(new Error('boom'));
        expect(store.loadError('g1')).toBe(true);
        expect(store.loading('g1')).toBe(false);

        store.loadFor('g1');
        expect(store.loading('g1')).toBe(true);
        api.listPending[1].next([event('e1')]);
        api.listPending[1].complete();

        expect(store.loadError('g1')).toBe(false);
        expect(store.loading('g1')).toBe(false);
    });

    it('toggleInterest optimistically flips isInterested and increments interestedCount, rolling both back on error', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.listPending[0].next([event('e1', {isInterested: false, interestedCount: 3})]);
        api.listPending[0].complete();

        const ev = store.eventsForGuild('g1')[0];
        let caughtError: unknown;
        store.toggleInterest(ev).subscribe({
            error: err => {
                caughtError = err;
            },
        });

        // Optimistic update is applied synchronously, before the request settles - but
        // only because the caller subscribed (toggleInterest is a cold Observable).
        let updated = store.eventsForGuild('g1')[0];
        expect(updated.isInterested).toBe(true);
        expect(updated.interestedCount).toBe(4);

        api.interestPending[0].error(new Error('boom'));

        updated = store.eventsForGuild('g1')[0];
        expect(updated.isInterested).toBe(false);
        expect(updated.interestedCount).toBe(3);
        expect(caughtError).toBeInstanceOf(Error);
    });

    it('toggleInterest on an interested event optimistically decrements and does not roll back on success', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.listPending[0].next([event('e1', {isInterested: true, interestedCount: 5})]);
        api.listPending[0].complete();

        const ev = store.eventsForGuild('g1')[0];
        store.toggleInterest(ev).subscribe();

        let updated = store.eventsForGuild('g1')[0];
        expect(updated.isInterested).toBe(false);
        expect(updated.interestedCount).toBe(4);

        api.interestPending[0].next(undefined);
        api.interestPending[0].complete();

        updated = store.eventsForGuild('g1')[0];
        expect(updated.isInterested).toBe(false);
        expect(updated.interestedCount).toBe(4);
    });

    it('toggleInterest does not touch state unless the caller subscribes (cold Observable)', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.listPending[0].next([event('e1', {isInterested: false, interestedCount: 3})]);
        api.listPending[0].complete();

        const ev = store.eventsForGuild('g1')[0];
        store.toggleInterest(ev); // deliberately not subscribed

        const untouched = store.eventsForGuild('g1')[0];
        expect(untouched.isInterested).toBe(false);
        expect(untouched.interestedCount).toBe(3);
        expect(api.interestPending.length).toBe(0);
    });

    it('cancel removes the event from eventsForGuild', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.listPending[0].next([event('e1'), event('e2')]);
        api.listPending[0].complete();

        store.cancel('e1').subscribe();

        expect(store.eventsForGuild('g1').map(e => e.id)).toEqual(['e2']);
    });

    it('cancel does not remove anything unless the caller subscribes (cold Observable)', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.listPending[0].next([event('e1'), event('e2')]);
        api.listPending[0].complete();

        store.cancel('e1'); // deliberately not subscribed

        expect(store.eventsForGuild('g1').map(e => e.id)).toEqual(['e1', 'e2']);
    });

    it('cancel propagates an error to the subscriber and does not remove the entity', () => {
        const {api, store} = setup();
        api.cancelResult = throwError(() => new Error('boom'));

        store.loadFor('g1');
        api.listPending[0].next([event('e1'), event('e2')]);
        api.listPending[0].complete();

        let caughtError: unknown;
        store.cancel('e1').subscribe({
            error: err => {
                caughtError = err;
            },
        });

        expect(caughtError).toBeInstanceOf(Error);
        expect(store.eventsForGuild('g1').map(e => e.id)).toEqual(['e1', 'e2']);
    });

    it('create upserts the returned entity', () => {
        const {store} = setup();

        store.create('g1', {title: 'New event', startsAt: '2026-08-10T00:00:00Z'}).subscribe();

        expect(store.eventsForGuild('g1').map(e => e.id)).toEqual(['created']);
    });

    it('update upserts the returned entity', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.listPending[0].next([event('e1', {title: 'Old title'})]);
        api.listPending[0].complete();

        store.update('e1', {title: 'New title'}).subscribe();

        expect(store.eventsForGuild('g1')[0].title).toBe('New title');
    });

    it('applyRealtimeCreatedOrUpdated (via websocket) clears the loaded flag and refetches', () => {
        const {api, ws, store} = setup();

        store.loadFor('g1');
        api.listPending[0].next([event('e1')]);
        api.listPending[0].complete();
        expect(api.requestCount).toBe(1);

        ws.emit('guild.EventCreated', {
            guildId: 'g1',
            eventId: 'e2',
            title: 'New event',
            startsAt: '2026-08-05T00:00:00Z',
        });

        // A refetch was triggered rather than synthesizing a partial entity from the
        // realtime payload (it lacks interestedCount/isInterested).
        expect(api.requestCount).toBe(2);

        api.listPending[1].next([event('e1'), event('e2')]);
        api.listPending[1].complete();

        expect(store.eventsForGuild('g1').map(e => e.id)).toEqual(['e1', 'e2']);
    });

    it('applyRealtimeCancelled (via websocket) removes the entity', () => {
        const {api, ws, store} = setup();

        store.loadFor('g1');
        api.listPending[0].next([event('e1'), event('e2')]);
        api.listPending[0].complete();

        ws.emit('guild.EventCancelled', {guildId: 'g1', eventId: 'e1'});

        expect(store.eventsForGuild('g1').map(e => e.id)).toEqual(['e2']);
    });
});
