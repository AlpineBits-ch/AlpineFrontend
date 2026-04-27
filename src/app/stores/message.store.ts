import { inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import { addEntities, updateEntity, upsertEntity, withEntities } from '@ngrx/signals/entities';
import { MessageDto } from '../dtos/response/message.dto';
import { MessagingService } from '../services/messaging.service';
import { WebsocketService } from '../services/websocket.service';

const PAGE_SIZE = 30;

interface ConversationMeta {
  offset: number;
  hasMore: boolean;
  loadingMore: boolean;
}

interface MessageState {
  /** Per-conversation fetch metadata */
  conversationMeta: Record<string, ConversationMeta>;
}

export const MessageStore = signalStore(
  { providedIn: 'root' },
  withEntities<MessageDto>(),
  withState<MessageState>({ conversationMeta: {} }),

  withMethods((store, messagingService = inject(MessagingService)) => ({
    loadForConversation(conversationId: string): void {
      // Already fetched — no-op
      if (store.conversationMeta()[conversationId]) return;

      // Optimistically mark as loading so concurrent calls don't double-fetch
      patchState(store, {
        conversationMeta: {
          ...store.conversationMeta(),
          [conversationId]: { offset: 0, hasMore: true, loadingMore: true },
        },
      });

      messagingService
        .getMessagesForConversation(conversationId, 0, PAGE_SIZE)
        .subscribe(messages => {
          patchState(store, addEntities(messages), {
            conversationMeta: {
              ...store.conversationMeta(),
              [conversationId]: {
                offset: messages.length,
                hasMore: messages.length === PAGE_SIZE,
                loadingMore: false,
              },
            },
          });
        });
    },

    loadMoreForConversation(conversationId: string): void {
      const meta = store.conversationMeta()[conversationId];
      if (!meta || meta.loadingMore || !meta.hasMore) return;

      patchState(store, {
        conversationMeta: {
          ...store.conversationMeta(),
          [conversationId]: { ...meta, loadingMore: true },
        },
      });

      messagingService
        .getMessagesForConversation(conversationId, meta.offset, PAGE_SIZE)
        .subscribe(messages => {
          patchState(store, addEntities(messages), {
            conversationMeta: {
              ...store.conversationMeta(),
              [conversationId]: {
                offset: meta.offset + messages.length,
                hasMore: messages.length === PAGE_SIZE,
                loadingMore: false,
              },
            },
          });
        });
    },

    addMessage(msg: MessageDto): void {
      patchState(store, upsertEntity(msg));
    },

    /** Replace a pending (optimistic) message with the confirmed server response */
    confirmMessage(tempId: string, confirmed: MessageDto): void {
      patchState(store, updateEntity({ id: tempId, changes: { ...confirmed, isPending: false, isFailed: false } }));
    },

    /** Mark a pending message as failed */
    failMessage(tempId: string): void {
      patchState(store, updateEntity({ id: tempId, changes: { isPending: false, isFailed: true } }));
    },
  })),

  withHooks({
    onInit(store) {
      const wsService = inject(WebsocketService);
      wsService.messageObservable.subscribe(msg =>
        patchState(store, upsertEntity(msg))
      );
    },
  })
);
