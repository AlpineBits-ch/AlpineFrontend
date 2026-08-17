import {inject, Injectable} from '@angular/core';
import {Subject} from 'rxjs';
import {RealtimeConnectionService} from './realtime-connection.service';
import {RelationshipStatus} from '../models/relationship.model';

/**
 * Server → client payload shared by all four `social.*` relationship events.
 *
 * Each event is pushed to *both* users involved, and every recipient gets their own view
 * of the row: `relationshipId` and `status` are yours (the id can be passed straight back
 * to /accept, /reject or /revoke), while `userId`/`profileId`/`userName` always describe
 * the other party.
 */
export interface RelationshipEvent {
    /** Your own relationship row id -valid for /accept, /reject and /revoke. */
    relationshipId: string;
    /** Your view after the change: PendingIncoming | PendingOutgoing | Friends | None. */
    status: RelationshipStatus;
    /** The other party. */
    userId: string;
    /** The other party. */
    profileId: string;
    /** The other party. */
    userName: string;
}

/**
 * Transport for the `social.*` relationship events on the shared realtime connection.
 *
 * Deliberately thin: it only fans the payloads out as observables. State lives in
 * {@link RelationshipStore}, which is also where the desktop notifications are raised -
 * deciding whether an event is worth announcing needs the *previous* status of the row
 * (see the note on `applyRealtime` there), which the wire payload doesn't carry.
 */
@Injectable({providedIn: 'root'})
export class SocialWebsocketService {
    /**
     * POST /api/v1/social/relationships. The target sees `PendingIncoming`; the initiator
     * gets their own copy as `PendingOutgoing` so their other devices stay in sync.
     */
    public readonly friendRequestCreatedObservable = new Subject<RelationshipEvent>();

    /** POST …/{id}/accept. Both sides see `Friends`. */
    public readonly friendRequestAcceptedObservable = new Subject<RelationshipEvent>();

    /** POST …/{id}/reject. Both sides see `None`. */
    public readonly friendRequestRejectedObservable = new Subject<RelationshipEvent>();

    /** POST …/{id}/revoke -covers unfriending and cancelling your own outgoing request. Both sides see `None`. */
    public readonly friendRemovedObservable = new Subject<RelationshipEvent>();

    private realtime = inject(RealtimeConnectionService);
    private listenersSetUp = false;

    /** Shared connection state -one connection backs every feature. */
    get connectionState() {
        return this.realtime.connectionState;
    }

    async start(): Promise<void> {
        if (!this.listenersSetUp) {
            this.listenersSetUp = true;
            this.setupListeners();
        }
        await this.realtime.start();
    }

    private setupListeners(): void {
        this.realtime.on('social.FriendRequestCreated', (data: RelationshipEvent) =>
            this.friendRequestCreatedObservable.next(data),
        );

        this.realtime.on('social.FriendRequestAccepted', (data: RelationshipEvent) =>
            this.friendRequestAcceptedObservable.next(data),
        );

        this.realtime.on('social.FriendRequestRejected', (data: RelationshipEvent) =>
            this.friendRequestRejectedObservable.next(data),
        );

        this.realtime.on('social.FriendRemoved', (data: RelationshipEvent) =>
            this.friendRemovedObservable.next(data),
        );
    }
}
