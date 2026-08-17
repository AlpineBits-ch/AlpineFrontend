import {inject} from '@angular/core';
import {patchState, signalStore, withHooks, withMethods, withState} from '@ngrx/signals';
import {
    addEntities,
    removeEntity,
    setAllEntities,
    updateEntity,
    upsertEntity,
    withEntities,
} from '@ngrx/signals/entities';
import {ConversationDto} from '../dtos/response/conversation.dto';
import {ConversationService} from '../services/conversation.service';
import {MessagingWebsocketService} from '../services/messaging-websocket.service';
import {ProfileService} from '../services/profile.service';

const PAGE_SIZE = 20;

interface ConversationState {
    loaded: boolean;
    loading: boolean;
    offset: number;
    hasMore: boolean;
}

export const ConversationStore = signalStore(
    {providedIn: 'root'},
    withEntities<ConversationDto>(),
    withState<ConversationState>({loaded: false, loading: false, offset: 0, hasMore: true}),

    withMethods((store, service = inject(ConversationService)) => ({
        loadInitial(): void {
            if (store.loaded() || store.loading()) return;
            patchState(store, {loading: true});
            service.getConversations(0, PAGE_SIZE).subscribe(convs => {
                patchState(store, setAllEntities(convs), {
                    loaded: true,
                    loading: false,
                    offset: convs.length,
                    hasMore: convs.length === PAGE_SIZE,
                });
            });
        },

        loadMore(): void {
            if (store.loading() || !store.hasMore()) return;
            patchState(store, {loading: true});
            service.getConversations(store.offset(), PAGE_SIZE).subscribe(convs => {
                patchState(store, addEntities(convs), {
                    loading: false,
                    offset: store.offset() + convs.length,
                    hasMore: convs.length === PAGE_SIZE,
                });
            });
        },

        /** Adds, or replaces the copy already held: a create can answer with a conversation we hold stale. */
        addConversation(conv: ConversationDto): void {
            patchState(store, upsertEntity(conv));
        },

        removeConversation(id: string): void {
            patchState(store, removeEntity(id));
        },

        /** Applies a name or icon change without refetching the conversation. */
        applyEdit(conversationId: string, name: string | null, iconUpdatedAt: string | null): void {
            patchState(
                store,
                updateEntity({
                    id: conversationId,
                    changes: {name: name ?? undefined, iconUpdatedAt},
                }),
            );
        },

        bumpUpdatedAt(conversationId: string): void {
            patchState(store, updateEntity({id: conversationId, changes: {updatedAt: new Date()}}));
        },

        updateMemberLastRead(conversationId: string, userId: string, lastReadMessageId: string): void {
            const conv = store.entityMap()[conversationId];
            if (!conv) return;
            // A no-op write still hands out a new entity object, and anything reading the open
            // conversation off the store treats that as a change.
            if (conv.members.some(m => m.userId === userId && m.lastReadMessageId === lastReadMessageId)) {
                return;
            }
            patchState(
                store,
                updateEntity({
                    id: conversationId,
                    changes: {
                        members: conv.members.map(m => (m.userId === userId ? {...m, lastReadMessageId} : m)),
                    },
                }),
            );
        },
    })),

    withHooks({
        onInit(store) {
            const wsService = inject(MessagingWebsocketService);
            const profileService = inject(ProfileService);
            const conversationService = inject(ConversationService);

            /** Fetches a conversation we do not hold. Silent on failure - a retry costs nothing. */
            const ensureLoaded = (conversationId: string): boolean => {
                if (store.entityMap()[conversationId]) return true;
                conversationService.getConversationById(conversationId).subscribe({
                    next: conv => patchState(store, addEntities([conv])),
                    error: () => undefined,
                });
                return false;
            };

            wsService.conversationCreatedObservable.subscribe(id => ensureLoaded(id));

            wsService.messageObservable.subscribe(msg => {
                if (!msg.conversationId) return;

                // A message can be the first we hear of a conversation. The server opens one on our
                // behalf when somebody rings us into a voice channel and we have never DM'd them, and
                // the two announcements travel as separate bus messages with no ordering between
                // them - so this arriving first is ordinary, not a bug. `updateEntity` on an id the
                // store does not hold is a silent no-op, which is how the conversation used to stay
                // invisible until the next full reload.
                if (!ensureLoaded(msg.conversationId)) return;

                patchState(store, updateEntity({id: msg.conversationId, changes: {updatedAt: new Date()}}));
            });

            wsService.conversationRemovedObservable.subscribe(event =>
                patchState(store, removeEntity(event.conversationId)),
            );

            wsService.conversationUpdatedObservable.subscribe(event => {
                if (!ensureLoaded(event.conversationId)) return;
                patchState(
                    store,
                    updateEntity({
                        id: event.conversationId,
                        changes: {name: event.name ?? undefined, iconUpdatedAt: event.iconUpdatedAt},
                    }),
                );
            });

            wsService.conversationMemberRemovedObservable.subscribe(event => {
                if (event.userId === profileService.ownProfile()?.userId) {
                    patchState(store, removeEntity(event.conversationId));
                }
            });
        },
    }),
);
