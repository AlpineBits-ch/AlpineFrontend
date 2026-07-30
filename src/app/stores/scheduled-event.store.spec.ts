import {TestBed} from '@angular/core/testing';
import {Observable, of, Subject} from 'rxjs';
import {ScheduledEventStore} from './scheduled-event.store';
import {ScheduledEventService} from '../services/scheduled-event.service';
import {
    CreateScheduledEventDto,
    ScheduledEventDto,
    ScheduledEventStatus,
    UpdateScheduledEventDto,
} from '../dtos/response/scheduled-event.dto';
import {GuildWebsocketService, WsEventCancelled, WsEventCreated, WsEventUpdated} from '../services/guild-websocket.service';

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

    cancel(_eventId: string): Observable<void> {
        return of(undefined);
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

class FakeGuildWebsocketService {
    eventCreatedObservable = new Subject<WsEventCreated>();
    eventUpdatedObservable = new Subject<WsEventUpdated>();
    eventCancelledObservable = new Subject<WsEventCancelled>();
}

function setup() {
    const api = new FakeScheduledEventService();
    const ws = new FakeGuildWebsocketService();
    TestBed.configureTestingModule({
        providers: [
            {provide: ScheduledEventService, useValue: api},
            {provide: GuildWebsocketService, useValue: ws},
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

    it('toggleInterest optimistically flips isInterested and increments interestedCount, rolling both back on error', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.listPending[0].next([event('e1', {isInterested: false, interestedCount: 3})]);
        api.listPending[0].complete();

        const ev = store.eventsForGuild('g1')[0];
        store.toggleInterest(ev);

        // Optimistic update is applied synchronously, before the request settles.
        let updated = store.eventsForGuild('g1')[0];
        expect(updated.isInterested).toBe(true);
        expect(updated.interestedCount).toBe(4);

        api.interestPending[0].error(new Error('boom'));

        updated = store.eventsForGuild('g1')[0];
        expect(updated.isInterested).toBe(false);
        expect(updated.interestedCount).toBe(3);
    });

    it('toggleInterest on an interested event optimistically decrements and does not roll back on success', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.listPending[0].next([event('e1', {isInterested: true, interestedCount: 5})]);
        api.listPending[0].complete();

        const ev = store.eventsForGuild('g1')[0];
        store.toggleInterest(ev);

        let updated = store.eventsForGuild('g1')[0];
        expect(updated.isInterested).toBe(false);
        expect(updated.interestedCount).toBe(4);

        api.interestPending[0].next(undefined);
        api.interestPending[0].complete();

        updated = store.eventsForGuild('g1')[0];
        expect(updated.isInterested).toBe(false);
        expect(updated.interestedCount).toBe(4);
    });

    it('cancel removes the event from eventsForGuild', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.listPending[0].next([event('e1'), event('e2')]);
        api.listPending[0].complete();

        store.cancel('e1');

        expect(store.eventsForGuild('g1').map(e => e.id)).toEqual(['e2']);
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

        ws.eventCreatedObservable.next({guildId: 'g1', eventId: 'e2', title: 'New event', startsAt: '2026-08-05T00:00:00Z'});

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

        ws.eventCancelledObservable.next({guildId: 'g1', eventId: 'e1'});

        expect(store.eventsForGuild('g1').map(e => e.id)).toEqual(['e2']);
    });
});
