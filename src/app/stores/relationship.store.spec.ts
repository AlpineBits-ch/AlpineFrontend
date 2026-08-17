import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {Observable, of, Subject} from 'rxjs';
import {RelationshipStore} from './relationship.store';
import {RelationshipService} from '../services/relationship.service';
import {ProfileService} from '../services/profile.service';
import {NotificationService} from '../services/notification.service';
import {RelationshipEvent, SocialWebsocketService} from '../services/social-websocket.service';
import {
    MinimalProfileId,
    RelationshipModel,
    RelationshipStatus,
} from '../models/relationship.model';

const OWN_USER_ID = 'usr_me';

function profile(name: string): MinimalProfileId {
    return {id: `prfl_${name}`, userId: `usr_${name}`, userName: name};
}

function relationship(id: string, owner: MinimalProfileId, target: MinimalProfileId, status: RelationshipStatus): RelationshipModel {
    return {id, ownerId: owner.userId, owner, targetId: target.userId, target, status};
}

function event(overrides: Partial<RelationshipEvent> = {}): RelationshipEvent {
    return {
        relationshipId: 'rlsp_1',
        status: RelationshipStatus.PendingIncoming,
        userId: 'usr_alice',
        profileId: 'prfl_alice',
        userName: 'alice',
        ...overrides,
    };
}

/** Subject-backed so response timing is controlled and requests can be counted. */
class FakeRelationshipService {
    listPending: Subject<RelationshipModel[]>[] = [];
    createResult: RelationshipModel = relationship('rlsp_new', profile('me'), profile('bob'), RelationshipStatus.PendingOutgoing);
    accepted: string[] = [];
    rejected: string[] = [];
    revoked: string[] = [];

    get requestCount(): number {
        return this.listPending.length;
    }

    getRelationships(): Observable<RelationshipModel[]> {
        const subject = new Subject<RelationshipModel[]>();
        this.listPending.push(subject);
        return subject.asObservable();
    }

    createFriendRequest(_username: string): Observable<RelationshipModel> {
        return of(this.createResult);
    }

    acceptFriendRequest(id: string): Observable<RelationshipModel> {
        this.accepted.push(id);
        return of(relationship(id, profile('alice'), profile('me'), RelationshipStatus.Friends));
    }

    rejectFriendRequest(id: string): Observable<RelationshipModel> {
        this.rejected.push(id);
        return of(relationship(id, profile('alice'), profile('me'), RelationshipStatus.None));
    }

    revokeFriendRequest(id: string): Observable<RelationshipModel> {
        this.revoked.push(id);
        return of(relationship(id, profile('me'), profile('alice'), RelationshipStatus.None));
    }
}

class FakeProfileService {
    readonly ownProfile = signal<{ userId: string } | undefined>({userId: OWN_USER_ID});
    resolved: string[] = [];

    resolveByUserId(userId: string): void {
        this.resolved.push(userId);
    }
}

class FakeNotificationService {
    created: { title: string; message: string }[] = [];

    createNotification(opts: { title: string; message: string }): Promise<void> {
        this.created.push({title: opts.title, message: opts.message});
        return Promise.resolve();
    }
}

class FakeSocialWebsocketService {
    friendRequestCreatedObservable = new Subject<RelationshipEvent>();
    friendRequestAcceptedObservable = new Subject<RelationshipEvent>();
    friendRequestRejectedObservable = new Subject<RelationshipEvent>();
    friendRemovedObservable = new Subject<RelationshipEvent>();
    readonly connectionState = signal(0); // ConnectionState.Connected
}

function setup(ownProfileLoaded = true) {
    const api = new FakeRelationshipService();
    const profiles = new FakeProfileService();
    const notifications = new FakeNotificationService();
    const ws = new FakeSocialWebsocketService();

    if (!ownProfileLoaded) profiles.ownProfile.set(undefined);

    TestBed.configureTestingModule({
        providers: [
            {provide: RelationshipService, useValue: api},
            {provide: ProfileService, useValue: profiles},
            {provide: NotificationService, useValue: notifications},
            {provide: SocialWebsocketService, useValue: ws},
        ],
    });

    return {api, profiles, notifications, ws, store: TestBed.inject(RelationshipStore)};
}

describe('RelationshipStore', () => {
    describe('load', () => {
        it('resolves "the other party" from whichever side we are on', () => {
            const {api, store} = setup();
            const me = {...profile('me'), userId: OWN_USER_ID};

            store.load();
            api.listPending[0].next([
                // We sent this one, so we're the owner and the friend is the target...
                relationship('rlsp_1', me, profile('alice'), RelationshipStatus.Friends),
                // ...and we received this one, so it's the other way round.
                relationship('rlsp_2', profile('bob'), me, RelationshipStatus.Friends),
            ]);
            api.listPending[0].complete();

            expect(store.friends().map(r => r.other.userName)).toEqual(['alice', 'bob']);
        });

        it('is idempotent across the several components that call it', () => {
            const {api, store} = setup();

            store.load();
            store.load();
            api.listPending[0].next([]);
            api.listPending[0].complete();
            store.load();

            expect(api.requestCount).toBe(1);
        });

        it('does not stall when the signed-in profile has not arrived yet, and corrects itself once it does', () => {
            const {api, profiles, store} = setup(false);
            const me = {...profile('me'), userId: OWN_USER_ID};

            store.load();
            // The fetch goes out immediately rather than waiting on /profiles/me...
            expect(api.requestCount).toBe(1);

            api.listPending[0].next([
                relationship('rlsp_1', me, profile('alice'), RelationshipStatus.PendingOutgoing),
                relationship('rlsp_2', me, profile('carol'), RelationshipStatus.Friends),
            ]);
            api.listPending[0].complete();

            // ...and the status alone is enough to place pending rows correctly.
            expect(store.outgoing().map(r => r.other.userName)).toEqual(['alice']);
            // A Friends row genuinely needs to know which side we are, so it resolves as
            // soon as the profile lands - no refetch.
            profiles.ownProfile.set({userId: OWN_USER_ID});
            expect(store.friends().map(r => r.other.userName)).toEqual(['carol']);
            expect(api.requestCount).toBe(1);
        });

        it('allows a retry after a failed fetch', () => {
            const {api, store} = setup();

            store.load();
            api.listPending[0].error(new Error('boom'));
            expect(store.error()).toBe(true);

            store.load();
            expect(api.requestCount).toBe(2);
        });

    });

    describe('realtime events', () => {
        it('FriendRequestCreated adds an incoming request and notifies', () => {
            const {ws, notifications, store} = setup();

            ws.friendRequestCreatedObservable.next(event({status: RelationshipStatus.PendingIncoming}));

            expect(store.incoming().map(r => r.other.userName)).toEqual(['alice']);
            expect(notifications.created).toEqual([
                {title: 'Friend request', message: 'alice sent you a friend request'},
            ]);
        });

        it('FriendRequestCreated stays silent for the initiator\'s own multi-device copy', () => {
            const {ws, notifications, store} = setup();

            ws.friendRequestCreatedObservable.next(event({status: RelationshipStatus.PendingOutgoing}));

            // Still recorded - another device of ours sent it and this is how we find out.
            expect(store.outgoing().map(r => r.other.userName)).toEqual(['alice']);
            expect(notifications.created).toEqual([]);
        });

        it('FriendRequestAccepted moves the row to Friends and notifies the requester', () => {
            const {ws, notifications, store} = setup();

            ws.friendRequestCreatedObservable.next(event({status: RelationshipStatus.PendingOutgoing}));
            ws.friendRequestAcceptedObservable.next(event({status: RelationshipStatus.Friends}));

            expect(store.outgoing()).toEqual([]);
            expect(store.friends().map(r => r.other.userName)).toEqual(['alice']);
            expect(notifications.created).toEqual([
                {title: 'Friend request accepted', message: 'alice accepted your friend request'},
            ]);
        });

        it('FriendRequestAccepted stays silent on the accepter\'s other devices', () => {
            const {ws, notifications, store} = setup();

            // This device saw the request as incoming, so we are the one who accepted -
            // being told "alice accepted your friend request" would be backwards.
            ws.friendRequestCreatedObservable.next(event({status: RelationshipStatus.PendingIncoming}));
            notifications.created.length = 0;

            ws.friendRequestAcceptedObservable.next(event({status: RelationshipStatus.Friends}));

            expect(store.friends().map(r => r.other.userName)).toEqual(['alice']);
            expect(notifications.created).toEqual([]);
        });

        it('FriendRequestRejected drops the row without notifying', () => {
            const {ws, notifications, store} = setup();

            ws.friendRequestCreatedObservable.next(event({status: RelationshipStatus.PendingOutgoing}));
            notifications.created.length = 0;

            ws.friendRequestRejectedObservable.next(event({status: RelationshipStatus.None}));

            expect(store.relationships()).toEqual([]);
            expect(notifications.created).toEqual([]);
        });

        it('FriendRemoved drops the row without notifying', () => {
            const {ws, notifications, store} = setup();

            ws.friendRequestCreatedObservable.next(event({status: RelationshipStatus.PendingIncoming}));
            ws.friendRequestAcceptedObservable.next(event({status: RelationshipStatus.Friends}));
            notifications.created.length = 0;

            ws.friendRemovedObservable.next(event({status: RelationshipStatus.None}));

            expect(store.friends()).toEqual([]);
            expect(notifications.created).toEqual([]);
        });

        it('never refetches - the payload is the recipient\'s own view of the row', () => {
            const {api, ws, store} = setup();

            store.load();
            api.listPending[0].next([]);
            api.listPending[0].complete();

            ws.friendRequestCreatedObservable.next(event());
            ws.friendRequestAcceptedObservable.next(event({status: RelationshipStatus.Friends}));

            expect(api.requestCount).toBe(1);
        });
    });

    describe('local actions', () => {
        it('sendRequest records the returned outgoing row', () => {
            const {store} = setup();

            store.sendRequest('bob').subscribe();

            expect(store.outgoing().map(r => r.other.userName)).toEqual(['bob']);
        });

        it('accept flips the row to Friends without waiting for the realtime event', () => {
            const {api, ws, store} = setup();

            ws.friendRequestCreatedObservable.next(event());
            store.accept('rlsp_1').subscribe();

            expect(api.accepted).toEqual(['rlsp_1']);
            expect(store.friends().map(r => r.other.userName)).toEqual(['alice']);
            expect(store.incoming()).toEqual([]);
        });

        it('reject and revoke remove the row locally', () => {
            const {api, ws, store} = setup();

            ws.friendRequestCreatedObservable.next(event({relationshipId: 'rlsp_1'}));
            ws.friendRequestCreatedObservable.next(event({
                relationshipId: 'rlsp_2',
                status: RelationshipStatus.PendingOutgoing,
                userName: 'bob',
                userId: 'usr_bob',
            }));

            store.reject('rlsp_1').subscribe();
            store.revoke('rlsp_2').subscribe();

            expect(api.rejected).toEqual(['rlsp_1']);
            expect(api.revoked).toEqual(['rlsp_2']);
            expect(store.relationships()).toEqual([]);
        });

        it('applying the realtime echo of a local action is a no-op', () => {
            const {ws, store} = setup();

            ws.friendRequestCreatedObservable.next(event());
            store.accept('rlsp_1').subscribe();
            // The server pushes the same transition to us moments later.
            ws.friendRequestAcceptedObservable.next(event({status: RelationshipStatus.Friends}));

            expect(store.friends().length).toBe(1);
        });
    });

    it('pendingCount counts both directions', () => {
        const {ws, store} = setup();

        ws.friendRequestCreatedObservable.next(event({relationshipId: 'rlsp_1'}));
        ws.friendRequestCreatedObservable.next(event({
            relationshipId: 'rlsp_2',
            status: RelationshipStatus.PendingOutgoing,
        }));
        ws.friendRequestAcceptedObservable.next(event({relationshipId: 'rlsp_3', status: RelationshipStatus.Friends}));

        expect(store.pendingCount()).toBe(2);
    });
});
