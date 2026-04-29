import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { addEntities, setAllEntities, withEntities } from '@ngrx/signals/entities';
import { ConversationDto } from '../dtos/response/conversation.dto';
import { ConversationService } from '../services/conversation.service';

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
  }))
);
