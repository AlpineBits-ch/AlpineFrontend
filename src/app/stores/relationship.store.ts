import {computed, effect, inject, untracked} from '@angular/core';
import {patchState, signalStore, withComputed, withHooks, withMethods, withState} from '@ngrx/signals';
import {removeEntity, setAllEntities, updateEntity, upsertEntity, withEntities} from '@ngrx/signals/entities';
import {Observable, tap} from 'rxjs';
import {
    MinimalProfileId,
    RelationshipModel,
    RelationshipStatus,
    RelationshipView,
} from '../features/friendship/components/friendship-modal/dto/relationship.model';
import {RelationshipService} from '../services/relationship.service';
import {ProfileService} from '../services/profile.service';
import {NotificationService, NotificationSound} from '../services/notification.service';
import {RelationshipEvent, SocialWebsocketService} from '../services/social-websocket.service';
import {ConnectionState} from '../services/realtime-connection.service';

interface RelationshipState {
    loaded: boolean;
    loading: boolean;
    error: boolean;
}

/**
 * A stored row. Realtime events name the other party outright; REST rows are owner/target
 * -shaped and keep both sides, so who the other party is gets resolved on read. That also
 * means the list corrects itself the moment `/profiles/me` lands, without a refetch.
 */
type RelationshipEntity = { id: string; status: RelationshipStatus } & (
    | { other: MinimalProfileId; owner?: never; target?: never }
    | { other?: never; owner: MinimalProfileId; target: MinimalProfileId }
    );

function otherParty(e: RelationshipEntity, ownUserId: string | undefined): MinimalProfileId {
    if (e.other) return e.other;
    // `owner` is the initiator, so a request we sent is owned by us. Until our own profile
    // has loaded the status still pins down pending rows; only Friends/Blocked need the id.
    if (ownUserId) return e.owner.userId === ownUserId ? e.target : e.owner;
    return e.status === RelationshipStatus.PendingIncoming ? e.owner : e.target;
}

function fromRest(r: RelationshipModel): RelationshipEntity {
    return {id: r.id, status: r.status, owner: r.owner, target: r.target};
}

function fromEvent(e: RelationshipEvent): RelationshipEntity {
    return {
        id: e.relationshipId,
        status: e.status,
        other: {id: e.profileId, userId: e.userId, userName: e.userName},
    };
}

/**
 * Single source of truth for the signed-in user's relationships.
 *
 * Every consumer used to fetch `/relationships` itself and keep a private copy, so an
 * incoming friend request only showed up wherever someone had happened to subscribe. The
 * list is loaded once here and then maintained in place from the four `social.*` events -
 * each carries the recipient's own view of the row, so none of them need a refetch.
 */
export const RelationshipStore = signalStore(
    {providedIn: 'root'},
    withEntities<RelationshipEntity>(),
    withState<RelationshipState>({loaded: false, loading: false, error: false}),

    withComputed(store => {
        const profileService = inject(ProfileService);

        const relationships = computed<RelationshipView[]>(() => {
            const ownUserId = profileService.ownProfile()?.userId;
            return store.entities().map(e => ({
                id: e.id,
                status: e.status,
                other: otherParty(e, ownUserId),
            }));
        });

        const withStatus = (status: RelationshipStatus) =>
            computed(() => relationships().filter(r => r.status === status));

        return {
            relationships,
            friends: withStatus(RelationshipStatus.Friends),
            incoming: withStatus(RelationshipStatus.PendingIncoming),
            outgoing: withStatus(RelationshipStatus.PendingOutgoing),
            blocked: withStatus(RelationshipStatus.Blocked),
            pendingCount: computed(() => store.entities().filter(e =>
                e.status === RelationshipStatus.PendingIncoming || e.status === RelationshipStatus.PendingOutgoing,
            ).length),
        };
    }),

    withMethods((store, relationshipService = inject(RelationshipService)) => {
        function fetchList(): void {
            patchState(store, {loading: true});
            relationshipService.getRelationships().subscribe({
                next: rels => patchState(store, setAllEntities(rels.map(fromRest)), {
                    loading: false,
                    loaded: true,
                    error: false,
                }),
                // `loaded` stays false so the next caller retries; the error flag lets the UI
                // tell "no friends yet" apart from "the fetch failed".
                error: () => patchState(store, {loading: false, loaded: false, error: true}),
            });
        }

        return {
            /** Idempotent -every consumer can safely call this on construction. */
            load(): void {
                if (store.loaded() || store.loading()) return;
                fetchList();
            },

            /** Forces a refetch, replacing whatever is held. */
            refresh(): void {
                if (store.loading()) return;
                fetchList();
            },

            sendRequest(username: string): Observable<RelationshipModel> {
                return relationshipService.createFriendRequest(username).pipe(
                    tap(rel => patchState(store, upsertEntity(fromRest(rel)))),
                );
            },

            // accept/reject/revoke apply the change locally on success as well as through
            // the realtime event. Both are keyed by relationship id, so whichever lands
            // second is a no-op - and the UI still responds if the socket happens to be down.
            accept(id: string): Observable<RelationshipModel> {
                return relationshipService.acceptFriendRequest(id).pipe(
                    tap(() => patchState(store, updateEntity({
                        id,
                        changes: {status: RelationshipStatus.Friends},
                    }))),
                );
            },

            reject(id: string): Observable<RelationshipModel> {
                return relationshipService.rejectFriendRequest(id).pipe(
                    tap(() => patchState(store, removeEntity(id))),
                );
            },

            /** Unfriend, or cancel an outgoing request you sent. */
            revoke(id: string): Observable<RelationshipModel> {
                return relationshipService.revokeFriendRequest(id).pipe(
                    tap(() => patchState(store, removeEntity(id))),
                );
            },

            /**
             * Blocks a user (T0-3).
             *
             * <p>Keyed by <b>user</b> id, not relationship id: a block is the one relationship you
             * can create with someone you have no row with at all. It also removes an existing
             * friendship and cancels a pending request either way round, so the whole list is
             * refetched rather than patched - working out locally which rows the server just
             * deleted would be guessing at its rules.</p>
             */
            block(userId: string): Observable<void> {
                return relationshipService.blockUser(userId).pipe(
                    tap(() => fetchList()),
                );
            },

            /** Lifts a block. Idempotent server-side. */
            unblock(userId: string): Observable<void> {
                return relationshipService.unblockUser(userId).pipe(
                    tap(() => fetchList()),
                );
            },

            applyRealtime(e: RelationshipEvent): void {
                if (e.status === RelationshipStatus.None) {
                    patchState(store, removeEntity(e.relationshipId));
                    return;
                }
                patchState(store, upsertEntity(fromEvent(e)));
            },
        };
    }),

    withHooks({
        onInit(store) {
            const socialWs = inject(SocialWebsocketService);
            const notificationService = inject(NotificationService);
            const profileService = inject(ProfileService);

            const notify = (title: string, message: string): void => {
                void notificationService.createNotification({
                    title,
                    message,
                    sound: NotificationSound.NewMessage,
                }).catch(() => {
                });
            };

            socialWs.friendRequestCreatedObservable.subscribe(e => {
                // Both parties receive this. Only the person who was asked gets told; the
                // initiator's PendingOutgoing copy exists purely to sync their own other
                // devices, and announcing your own action back at you is noise.
                const notifiable = e.status === RelationshipStatus.PendingIncoming;
                store.applyRealtime(e);
                if (notifiable) notify('Friend request', `${e.userName} sent you a friend request`);
            });

            socialWs.friendRequestAcceptedObservable.subscribe(e => {
                // Both parties see Friends, so the payload alone can't say who accepted. The
                // previous local status can: the requester's row was PendingOutgoing, while
                // the accepter's - on every one of their devices - was PendingIncoming.
                const notifiable = store.entityMap()[e.relationshipId]?.status === RelationshipStatus.PendingOutgoing;
                store.applyRealtime(e);
                if (notifiable) notify('Friend request accepted', `${e.userName} accepted your friend request`);
            });

            // Rejections and removals update the list silently.
            socialWs.friendRequestRejectedObservable.subscribe(e => store.applyRealtime(e));
            socialWs.friendRemovedObservable.subscribe(e => store.applyRealtime(e));

            // Warm the profile cache so avatars and presence dots have something to render.
            // An effect rather than a one-off after each change: the other party of a REST
            // row isn't known until /profiles/me lands, and this re-runs once it does.
            effect(() => {
                const rows = store.relationships();
                untracked(() => rows.forEach(r => profileService.resolveByUserId(r.other.userId)));
            });

            // SignalR doesn't replay events across a reconnect, so a drop would otherwise
            // leave the list stale with nothing left to invalidate it. Resync on the way back
            // up - but only after an actual disconnect, so the initial connect doesn't race
            // the load() every consumer already issues.
            let sawConnected = false;
            let sawDisconnect = false;
            effect(() => {
                const connected = socialWs.connectionState() === ConnectionState.Connected;
                if (connected) {
                    if (sawDisconnect) {
                        sawDisconnect = false;
                        untracked(() => store.refresh());
                    }
                    sawConnected = true;
                } else if (sawConnected) {
                    sawDisconnect = true;
                }
            });
        },
    }),
);
