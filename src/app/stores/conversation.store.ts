import { inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import { addEntities, removeEntity, setAllEntities, updateEntity, withEntities } from '@ngrx/signals/entities';
import { ConversationDto } from '../dtos/response/conversation.dto';
import { ConversationService } from '../services/conversation.service';
import { MessagingWebsocketService } from '../services/messaging-websocket.service';
import { ProfileService } from '../services/profile.service';

const PAGE_SIZE = 20;

interface ConversationState {
  loaded: boolean;
  loading: boolean;
  offset: number;
  hasMore: boolean;
}

export const ConversationStore = signalStore(
  { providedIn: 'root' },
  withEntities<ConversationDto>(),
  withState<ConversationState>({ loaded: false, loading: false, offset: 0, hasMore: true }),

  withMethods((store, service = inject(ConversationService)) => ({
    loadInitial(): void {
      if (store.loaded() || store.loading()) return;
      patchState(store, { loading: true });
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
      patchState(store, { loading: true });
      service.getConversations(store.offset(), PAGE_SIZE).subscribe(convs => {
        patchState(store, addEntities(convs), {
          loading: false,
          offset: store.offset() + convs.length,
          hasMore: convs.length === PAGE_SIZE,
        });
      });
    },

    addConversation(conv: ConversationDto): void {
      patchState(store, addEntities([conv]));
    },

    removeConversation(id: string): void {
      patchState(store, removeEntity(id));
    },

    bumpUpdatedAt(conversationId: string): void {
      patchState(store, updateEntity({ id: conversationId, changes: { updatedAt: new Date() } }));
    },
  })),

  withHooks({
    onInit(store) {
      const wsService = inject(MessagingWebsocketService);
      const profileService = inject(ProfileService);

      wsService.messageObservable.subscribe(msg => {
        if (msg.conversationId) {
          patchState(store, updateEntity({ id: msg.conversationId, changes: { updatedAt: new Date() } }));
        }
      });

      wsService.conversationRemovedObservable.subscribe(event =>
        patchState(store, removeEntity(event.conversationId))
      );

      wsService.conversationMemberRemovedObservable.subscribe(event => {
        if (event.userId === profileService.ownProfile()?.userId) {
          patchState(store, removeEntity(event.conversationId));
        }
      });
    },
  })
);
