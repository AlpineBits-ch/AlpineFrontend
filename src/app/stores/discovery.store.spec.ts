import {TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {Observable, Subject} from 'rxjs';
import {signal} from '@angular/core';
import {DiscoveryStore, discoveryFeedKey} from './discovery.store';
import {DiscoveryApiService} from '../services/discovery-api.service';
import {ProfileService} from '../services/profile.service';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {FakeRealtimeConnection} from '../testing/fake-realtime-connection';
import {DiscoveryCardDto, DiscoveryFeedDto, InterestsDto, ListingDto} from '../dtos/response/discovery.dto';
import {DiscoveryFeedQuery, ListingWriteDto, SaveInterestsDto} from '../dtos/request/discovery.dto';

function card(listingId: string, overrides: Partial<DiscoveryCardDto> = {}): DiscoveryCardDto {
    return {
        listingId,
        guildId: 'g1',
        guildName: 'Guild',
        guildIconUrl: null,
        guildBannerUrl: null,
        memberCount: 12,
        headline: 'Come roleplay with us',
        pitch: 'A cozy tavern for weekly one-shots.',
        topics: [],
        matchedTopics: [],
        language: 'en',
        joinPolicy: 'Open',
        lastBumpedAt: null,
        ...overrides,
    };
}

function listing(id: string, overrides: Partial<ListingDto> = {}): ListingDto {
    return {
        id,
        guildId: 'g1',
        headline: 'Original headline',
        pitch: 'Original pitch',
        topics: [],
        language: 'en',
        joinPolicy: 'Open',
        links: [],
        state: 'Draft',
        publishedAt: null,
        lastBumpedAt: null,
        bumpAvailableAt: null,
        suspendedReason: null,
        ...overrides,
    };
}

/** Subject-backed fake so response timing is fully controlled and requests can be counted. */
class FakeDiscoveryApiService {
    discoverPending: Subject<DiscoveryFeedDto>[] = [];
    listingPending: Subject<ListingDto>[] = [];
    publishPending: Subject<ListingDto>[] = [];
    saveInterestsPending: Subject<InterestsDto>[] = [];

    discover(_query: DiscoveryFeedQuery): Observable<DiscoveryFeedDto> {
        const subject = new Subject<DiscoveryFeedDto>();
        this.discoverPending.push(subject);
        return subject.asObservable();
    }

    getListing(_guildId: string): Observable<ListingDto> {
        const subject = new Subject<ListingDto>();
        this.listingPending.push(subject);
        return subject.asObservable();
    }

    saveListing(_guildId: string, _dto: ListingWriteDto): Observable<ListingDto> {
        return new Observable<ListingDto>();
    }

    publish(_guildId: string): Observable<ListingDto> {
        const subject = new Subject<ListingDto>();
        this.publishPending.push(subject);
        return subject.asObservable();
    }

    unlist(_guildId: string): Observable<ListingDto> {
        const subject = new Subject<ListingDto>();
        this.publishPending.push(subject);
        return subject.asObservable();
    }

    bump(_guildId: string): Observable<ListingDto> {
        return new Observable<ListingDto>();
    }

    getInterests(): Observable<never> {
        return new Observable<never>();
    }

    saveInterests(_dto: SaveInterestsDto): Observable<InterestsDto> {
        const subject = new Subject<InterestsDto>();
        this.saveInterestsPending.push(subject);
        return subject.asObservable();
    }
}

class FakeProfileService {
    readonly ownProfile = signal<{userId: string} | undefined>({userId: 'me'});
}

function setup() {
    const api = new FakeDiscoveryApiService();
    const ws = new FakeRealtimeConnection();
    TestBed.configureTestingModule({
        providers: [
            {provide: DiscoveryApiService, useValue: api},
            {provide: RealtimeConnectionService, useValue: ws},
            {provide: ProfileService, useValue: new FakeProfileService()},
        ],
    });
    return {api, ws, store: TestBed.inject(DiscoveryStore)};
}

describe('DiscoveryStore', () => {
    it('issues one request for back-to-back loads of the same feed key', () => {
        const {api, store} = setup();
        const key = discoveryFeedKey({q: 'roleplay'});

        store.loadFeed(key, {arg: {q: 'roleplay'}});
        store.loadFeed(key, {arg: {q: 'roleplay'}});
        store.loadFeed(key, {arg: {q: 'roleplay'}});

        expect(api.discoverPending.length).toBe(1);
    });

    it('applies the queued refetch when an interests change races an in-flight feed request', () => {
        const {api, ws, store} = setup();
        const key = discoveryFeedKey({q: 'roleplay'});

        store.loadFeed(key, {arg: {q: 'roleplay'}});
        expect(api.discoverPending.length).toBe(1);

        // Own interests changed on another device while the feed request is still in flight.
        ws.emit('discovery.InterestsChanged', {userId: 'me'});

        // Queued, not fired on top of the in-flight request.
        expect(api.discoverPending.length).toBe(1);

        api.discoverPending[0].next({cards: [card('l1')], nextCursor: null});
        api.discoverPending[0].complete();

        // The queued refetch goes out now that the original request settled.
        expect(api.discoverPending.length).toBe(2);

        api.discoverPending[1].next({cards: [card('l1'), card('l2')], nextCursor: null});
        api.discoverPending[1].complete();

        expect(
            store
                .feedFor(key)()
                .map(c => c.listingId),
        ).toEqual(['l1', 'l2']);
    });

    it('drops a listing event for a guild nobody has loaded', () => {
        const {api, ws, store} = setup();

        ws.emit('discovery.ListingPublished', {listingId: 'l1', guildId: 'other', state: 'Published'});

        expect(api.listingPending.length).toBe(0);
        expect(store.listingFor('other')()).toEqual([]);
    });

    it('rolls a failed publish back to the previous state', () => {
        const {api, store} = setup();

        store.loadListing('g1');
        api.listingPending[0].next(listing('lst1', {state: 'Draft'}));
        api.listingPending[0].complete();

        let caughtError: unknown;
        store.publish('g1').subscribe({
            error: err => {
                caughtError = err;
            },
        });

        // Optimistic flip applied synchronously, before the request settles.
        expect(store.listingFor('g1')()[0].state).toBe('Published');

        api.publishPending[0].error(new HttpErrorResponse({status: 500}));

        expect(store.listingFor('g1')()[0].state).toBe('Draft');
        expect(caughtError).toBeInstanceOf(HttpErrorResponse);
    });

    it('keeps the draft when publish is refused for entitlement', () => {
        const {api, store} = setup();

        store.loadListing('g1');
        api.listingPending[0].next(
            listing('lst1', {headline: 'My guild', pitch: 'Come hang out', state: 'Draft'}),
        );
        api.listingPending[0].complete();

        store.publish('g1').subscribe({error: () => undefined});
        api.publishPending[0].error(new HttpErrorResponse({status: 403}));

        const row = store.listingFor('g1')()[0];
        expect(row.state).toBe('Draft');
        expect(row.headline).toBe('My guild');
        expect(row.pitch).toBe('Come hang out');
    });

    it('lets a realtime refetch outrun an in-flight publish, keeping the newer server truth', () => {
        const {api, ws, store} = setup();

        store.loadListing('g1');
        api.listingPending[0].next(listing('lst1', {state: 'Draft', headline: 'Original headline'}));
        api.listingPending[0].complete();

        // Publish starts - optimistic flip applied, its own request still in flight.
        store.publish('g1').subscribe();
        expect(store.listingFor('g1')()[0].state).toBe('Published');

        // The broadcast for this same publish (or someone else's edit) arrives first and triggers a
        // refetch, which must be able to overwrite the optimistic guess.
        ws.emit('discovery.ListingPublished', {listingId: 'lst1', guildId: 'g1', state: 'Published'});
        expect(api.listingPending.length).toBe(2);

        api.listingPending[1].next(
            listing('lst1', {state: 'Published', headline: 'Edited elsewhere', publishedAt: 'now'}),
        );
        api.listingPending[1].complete();

        // The original publish request finally resolves with what is now a stale echo of its own
        // call - it must lose to the refetch above, not overwrite it.
        api.publishPending[0].next(listing('lst1', {state: 'Published', headline: 'Original headline'}));
        api.publishPending[0].complete();

        const row = store.listingFor('g1')()[0];
        expect(row.headline).toBe('Edited elsewhere');
        expect(row.publishedAt).toBe('now');
    });

    /** `interests: null` means "never loaded"; a clear-to-zero must land as a real empty object. */
    it('holds an empty set rather than null after saving interests down to zero', () => {
        const {api, store} = setup();

        store.saveInterests({topics: [], visible: true}).subscribe();
        api.saveInterestsPending[0].next({topics: [], visible: true});
        api.saveInterestsPending[0].complete();

        expect(store.interests()).not.toBeNull();
        expect(store.interests()).toEqual({topics: [], visible: true});
    });
});
