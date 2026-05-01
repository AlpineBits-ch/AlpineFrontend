import { inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import { addEntities, removeEntities, removeEntity, updateEntity, upsertEntity, withEntities } from '@ngrx/signals/entities';
import { MessageDto } from '../dtos/response/message.dto';
import { MessagingService } from '../services/messaging.service';
import { MessagingWebsocketService, MessageUpdatedEvent, MessageDeletedEvent } from '../services/messaging-websocket.service';
import { ProfileService } from '../services/profile.service';

const PAGE_SIZE = 30;

interface ConversationMeta {
  offset: number;
  hasMore: boolean;
  loadingMore: boolean;
}

interface SearchEntry {
  query: string;
  results: MessageDto[];
  searching: boolean;
}

interface MessageState {
  /** Per-conversation fetch metadata */
  conversationMeta: Record<string, ConversationMeta>;
  /** Per-conversation search state */
  searchEntries: Record<string, SearchEntry>;
}

function decodeContent(encoded: string): string {
  try {
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

function messageMatchesQuery(msg: MessageDto, q: string): boolean {
  if (decodeContent(msg.content).toLowerCase().includes(q)) return true;
  return msg.attachments.some(a => a.fileName.toLowerCase().includes(q));
}

export const MessageStore = signalStore(
  { providedIn: 'root' },
  withEntities<MessageDto>(),
  withState<MessageState>({ conversationMeta: {}, searchEntries: {} }),

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

    removeMessage(id: string): void {
      patchState(store, removeEntity(id));
    },

    applyMessageUpdate(dto: MessageDto): void {
      patchState(store, updateEntity({ id: dto.id, changes: dto }));
    },

    removeMessagesForConversation(conversationId: string): void {
      const ids = store.entities()
        .filter(m => m.conversationId === conversationId)
        .map(m => m.id);
      const meta = { ...store.conversationMeta() };
      delete meta[conversationId];
      patchState(store, removeEntities(ids), { conversationMeta: meta });
    },

    searchInConversation(conversationId: string, query: string): void {
      const q = query.trim().toLowerCase();
      if (!q) {
        const entries = { ...store.searchEntries() };
        delete entries[conversationId];
        patchState(store, { searchEntries: entries });
        return;
      }

      const localResults = store.entities()
        .filter(m => m.conversationId === conversationId && !m.isPending && !m.isFailed)
        .filter(m => messageMatchesQuery(m, q));

      const meta = store.conversationMeta()[conversationId];
      const needsRemote = meta?.hasMore ?? true;

      patchState(store, {
        searchEntries: {
          ...store.searchEntries(),
          [conversationId]: { query: q, results: localResults, searching: needsRemote },
        },
      });

      if (!needsRemote) return;

      messagingService.searchMessages(conversationId, q).subscribe({
        next: remoteResults => {
          patchState(store, addEntities(remoteResults));
          const localIds = new Set(localResults.map(m => m.id));
          const merged = [
            ...localResults,
            ...remoteResults.filter(r => !localIds.has(r.id)),
          ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          patchState(store, {
            searchEntries: {
              ...store.searchEntries(),
              [conversationId]: { query: q, results: merged, searching: false },
            },
          });
        },
        error: () => {
          patchState(store, {
            searchEntries: {
              ...store.searchEntries(),
              [conversationId]: { ...store.searchEntries()[conversationId], searching: false },
            },
          });
        },
      });
    },

    clearSearch(conversationId: string): void {
      const entries = { ...store.searchEntries() };
      delete entries[conversationId];
      patchState(store, { searchEntries: entries });
    },
  })),

  withHooks({
    onInit(store) {
      const wsService = inject(MessagingWebsocketService);
      const profileService = inject(ProfileService);

      wsService.messageObservable.subscribe(msg =>
        patchState(store, upsertEntity(msg))
      );

      wsService.messageUpdatedObservable.subscribe((event: MessageUpdatedEvent) =>
        patchState(store, updateEntity({
          id: event.messageId,
          changes: { content: event.content, updatedAt: new Date() },
        }))
      );

      wsService.messageDeletedObservable.subscribe((event: MessageDeletedEvent) =>
        patchState(store, removeEntity(event.messageId))
      );

      wsService.conversationRemovedObservable.subscribe(event => {
        const ids = store.entities()
          .filter(m => m.conversationId === event.conversationId)
          .map(m => m.id);
        const meta = { ...store.conversationMeta() };
        delete meta[event.conversationId];
        patchState(store, removeEntities(ids), { conversationMeta: meta });
      });

      wsService.conversationMemberRemovedObservable.subscribe(event => {
        if (event.userId !== profileService.ownProfile()?.userId) return;
        const ids = store.entities()
          .filter(m => m.conversationId === event.conversationId)
          .map(m => m.id);
        const meta = { ...store.conversationMeta() };
        delete meta[event.conversationId];
        patchState(store, removeEntities(ids), { conversationMeta: meta });
      });
    },
  })
);
