import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { debounceTime, Subject } from 'rxjs';

import { MessageAttachment, MessageDto } from '../../../../dtos/response/message.dto';
import { MessageStore } from '../../../../stores/message.store';
import { decodeContent } from './message-utils';

@Injectable()
export class ConversationSearchService {
  private messageStore = inject(MessageStore);
  private searchSubject = new Subject<string>();

  // Set by the host component whenever the active conversation changes.
  readonly conversationId = signal('');

  readonly searchQuery    = signal('');
  readonly searchEntry    = computed(() => this.messageStore.searchEntries()[this.conversationId()] ?? null);
  readonly isSearchActive = computed(() => this.searchQuery().trim().length > 0);
  readonly isSearching    = computed(() => this.searchEntry()?.searching ?? false);

  readonly msgResults = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    if (!q) return [];
    return (this.searchEntry()?.results ?? []).filter(m =>
      decodeContent(m.content).toLowerCase().includes(q)
    );
  });

  readonly attResults = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    if (!q) return [];
    const out: Array<{ message: MessageDto; attachment: MessageAttachment }> = [];
    for (const m of (this.searchEntry()?.results ?? [])) {
      for (const a of m.attachments) {
        if (a.fileName.toLowerCase().includes(q)) out.push({ message: m, attachment: a });
      }
    }
    return out;
  });

  constructor() {
    // Clear the query whenever the active conversation changes.
    effect(() => {
      this.conversationId();
      this.searchQuery.set('');
    }, { allowSignalWrites: true });

    // Debounce keystrokes before dispatching to the store.
    this.searchSubject.pipe(
      debounceTime(300),
      takeUntilDestroyed(),
    ).subscribe(query => {
      const id = this.conversationId();
      if (!id) return;
      if (query.trim()) {
        this.messageStore.searchInConversation(id, query);
      } else {
        this.messageStore.clearSearch(id);
      }
    });
  }

  onInput(value: string): void {
    this.searchQuery.set(value);
    this.searchSubject.next(value);
  }

  clear(): void {
    this.searchQuery.set('');
    this.messageStore.clearSearch(this.conversationId());
  }
}
