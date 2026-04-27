import { inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import { addEntities, upsertEntity, withEntities } from '@ngrx/signals/entities';
import { MessageDto } from '../dtos/response/message.dto';
import { MessagingService } from '../services/messaging.service';
import { WebsocketService } from '../services/websocket.service';

interface MessageState {
  /** Tracks which conversationIds have been fetched at least once */
  loadedConversations: Record<string, boolean>;
}

export const MessageStore = signalStore(
  { providedIn: 'root' },
  withEntities<MessageDto>(),
  withState<MessageState>({ loadedConversations: {} }),

  withMethods((store, messagingService = inject(MessagingService)) => ({
    loadForConversation(conversationId: string, offset = 0, limit = 30): void {
      if (store.loadedConversations()[conversationId]) return;
      messagingService
        .getMessagesForConversation(conversationId, offset, limit)
        .subscribe(messages => {
          patchState(
            store,
            addEntities(messages),
            { loadedConversations: { ...store.loadedConversations(), [conversationId]: true } }
          );
        });
    },

    loadMoreForConversation(conversationId: string, offset: number, limit = 30): void {
      messagingService
        .getMessagesForConversation(conversationId, offset, limit)
        .subscribe(messages => patchState(store, addEntities(messages)));
    },

    addMessage(msg: MessageDto): void {
      patchState(store, upsertEntity(msg));
    },
  })),

  withHooks({
    onInit(store) {
      const wsService = inject(WebsocketService);
      // All incoming realtime messages land here regardless of active view
      wsService.messageObservable.subscribe(msg =>
        patchState(store, upsertEntity(msg))
      );
    },
  })
);
