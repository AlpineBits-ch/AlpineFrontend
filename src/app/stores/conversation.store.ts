import {effect, inject} from '@angular/core';
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
import {ConversationCacheService} from '../services/cache/conversation-cache.service';
import {trace} from '../core/log';

const PAGE_SIZE = 20;

/** How long entity changes are batched for before the list is written to disk, in milliseconds. */
const PERSIST_WINDOW_MS = 1_000;

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

    withMethods((store, service = inject(ConversationService), cache = inject(ConversationCacheService)) => ({
        /**
         * Fills the store from the sealed cache, so the DM list is on screen with the splash rather
         * than a round trip after it. Leaves `loaded` false: this is a paint, not the load.
         *
         * @returns how many conversations came off disk, so the caller can log a cold start honestly.
         */
        async hydrate(): Promise<number> {
            const cached = await cache.recall();
            // The network copy is the authority. It can land first on a warm connection, and
            // repainting it from disk would put a stale list back on screen.
            if (cached.length === 0 || store.loaded()) return 0;

            patchState(store, setAllEntities(cached));
            return cached.length;
        },

        /**
         * Drops the list and the paging state, so the next account does not inherit them.
         *
         * Sign-out is an in-document navigate: no injector is destroyed, so without this the store
         * keeps the outgoing account's entities, loaded stays true and loadInitial never
         * refetches. The write-behind below turns that into durable residue, because an emptied
         * store persists as a delete rather than a write.
         */
        forget(): void {
            patchState(store, setAllEntities<ConversationDto>([]), {
                loaded: false,
                loading: false,
                offset: 0,
                hasMore: true,
            });
        },

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
            const cache = inject(ConversationCacheService);
            const profileService = inject(ProfileService);
            const conversationService = inject(ConversationService);

            // Write-behind for the whole list rather than a remember() in each method: every
            // method above changes what the next launch should paint, and `bumpUpdatedAt` fires on
            // every incoming message, so the writes are batched.
            let persistTimer: ReturnType<typeof setTimeout> | undefined;
            let latest: ConversationDto[] = [];
            effect(() => {
                latest = store.entities();
                if (persistTimer !== undefined) return;
                persistTimer = setTimeout(() => {
                    persistTimer = undefined;
                    // Swallowed: CacheStore.set rejects on a full or unavailable cache, which is an
                    // expected state, and an unhandled rejection here reaches GlobalErrorHandler.
                    void cache.remember(latest).catch((err: unknown) => {
                        trace('Conversations not cached; the cache is full or unavailable', err);
                    });
                }, PERSIST_WINDOW_MS);
            });

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
