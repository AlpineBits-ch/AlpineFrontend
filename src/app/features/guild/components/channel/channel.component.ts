import {
  afterEveryRender,
  AfterViewInit,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  ViewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { catchError, debounceTime, EMPTY, Subject, tap } from 'rxjs';

import { ChannelDto } from '../../../../dtos/response/guild.dto';
import { MessageAttachment, MessageDto } from '../../../../dtos/response/message.dto';

import { Button } from 'primeng/button';

import { MessagingService } from '../../../../services/messaging.service';
import { MessageStore } from '../../../../stores/message.store';
import { ProfileService } from '../../../../services/profile.service';
import { RelationshipService } from '../../../../services/relationship.service';
import { GuildWebsocketService } from '../../../../services/guild-websocket.service';
import { GuildReadStateService } from '../../../../services/guild-read-state.service';

import { ComposerComponent } from '../../../messaging/components/conversation/composer/composer.component';
import { NavigationService } from '../../../main-page/navigation.service';
import { MessageComponent } from '../../../messaging/components/conversation/message/message.component';
import { HighlightPipe } from '../../../../pipes/highlight.pipe';

const SCROLL_BOTTOM_THRESHOLD = 100;
const LOAD_MORE_THRESHOLD     = 400;

function decodeContent(encoded: string): string {
  try {
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

@Component({
  selector: 'app-channel',
  imports: [
    ComposerComponent, MessageComponent, Button,
    DatePipe, HighlightPipe,
  ],
  templateUrl: './channel.component.html',
  styleUrl: './channel.component.css',
})
export class ChannelComponent implements AfterViewInit {
  public channel = input.required<ChannelDto>();
  public back = output();

  private messageStore       = inject(MessageStore);
  private messagingService   = inject(MessagingService);
  private profileService     = inject(ProfileService);
  private relationshipService = inject(RelationshipService);
  private guildWs            = inject(GuildWebsocketService);
  private readStateService   = inject(GuildReadStateService);
  protected navService = inject(NavigationService);

  protected friends     = toSignal(this.relationshipService.getRelationships(), { initialValue: [] });
  protected replyingTo  = signal<MessageDto | null>(null);

  // ── Messages ─────────────────────────────────────────────────────────────

  protected messages = computed(() =>
    this.messageStore
      .entities()
      .filter(m => m.channelId === this.channel().id)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  );

  protected hasMore = computed(() =>
    this.messageStore.channelMeta()[this.channel().id]?.hasMore ?? false
  );

  protected loadingMore = computed(() =>
    this.messageStore.channelMeta()[this.channel().id]?.loadingMore ?? false
  );

  protected loadError = computed(() =>
    this.messageStore.channelMeta()[this.channel().id]?.error ?? null
  );

  // ── Search ───────────────────────────────────────────────────────────────

  private searchSubject = new Subject<string>();
  protected searchQuery = signal('');

  protected searchEntry = computed(() =>
    this.messageStore.channelSearchEntries()[this.channel().id] ?? null
  );
  protected isSearchActive = computed(() => this.searchQuery().trim().length > 0);
  protected isSearching    = computed(() => this.searchEntry()?.searching ?? false);

  protected msgResults = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    if (!q) return [];
    return (this.searchEntry()?.results ?? []).filter(m =>
      decodeContent(m.content).toLowerCase().includes(q)
    );
  });

  protected attResults = computed(() => {
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

  // ── Scroll state ─────────────────────────────────────────────────────────

  @ViewChild('messageScroll') private scrollRef!: ElementRef<HTMLDivElement>;
  @ViewChild('messageList')   private messageListRef?: ElementRef<HTMLDivElement>;
  @ViewChild(ComposerComponent) private composerRef?: ComposerComponent;
  private isNearBottom          = true;
  private savedScrollHeight     = 0;
  private restoreScroll         = false;
  private lastScrollChannelId   = '';
  private pendingScrollToBottom = false;
  private contentObserver       = new ResizeObserver(() => {
    if (this.isNearBottom) this.scrollToBottom();
  });
  private observedListEl?: HTMLDivElement;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  constructor() {
    inject(DestroyRef).onDestroy(() => this.contentObserver.disconnect());

    effect(() => {
      this.messageStore.loadForChannel(this.channel().id);
    });

    effect(() => {
      const channelId = this.channel().id;
      const _ = this.messages();

      if (channelId !== this.lastScrollChannelId) {
        this.lastScrollChannelId = channelId;
        this.isNearBottom  = true;
        this.restoreScroll = false;
      }

      if (this.isNearBottom) {
        this.pendingScrollToBottom = true;
      }
    });

    effect(() => {
      const _ = this.channel();
      setTimeout(() => this.composerRef?.focus(), 0);
    });

    effect(() => {
      this.channel().id;
      this.searchQuery.set('');
    }, { allowSignalWrites: true });

    afterEveryRender(() => {
      if (this.restoreScroll && this.scrollRef) {
        const el = this.scrollRef.nativeElement;
        const heightDiff = el.scrollHeight - this.savedScrollHeight;
        if (heightDiff > 0) el.scrollTop += heightDiff;
        this.restoreScroll    = false;
        this.savedScrollHeight = 0;
      } else if (this.pendingScrollToBottom && this.scrollRef) {
        this.scrollToBottom();
        this.pendingScrollToBottom = false;
      }

      const listEl = this.messageListRef?.nativeElement;
      if (listEl !== this.observedListEl) {
        this.contentObserver.disconnect();
        this.observedListEl = listEl;
        if (listEl) this.contentObserver.observe(listEl);
      }
    });

    effect(() => {
      const msgs = this.messages();
      const channelId = this.channel().id;
      if (msgs.length === 0) return;
      const latest = msgs[msgs.length - 1];
      if (latest.isPending || latest.isFailed) return;
      void this.guildWs.updateLastReadMessageByChannel(latest.id, channelId);
      this.readStateService.markChannelRead(channelId);
    });

    this.searchSubject.pipe(
      debounceTime(300),
      takeUntilDestroyed(),
    ).subscribe(query => {
      if (query.trim()) {
        this.messageStore.searchInChannel(this.channel().id, query);
      } else {
        this.messageStore.clearChannelSearch(this.channel().id);
      }
    });
  }

  ngAfterViewInit(): void {
    this.scrollToBottom();
  }

  // ── Scroll handling ──────────────────────────────────────────────────────

  protected onScroll(): void {
    const el = this.scrollRef.nativeElement;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.isNearBottom = fromBottom < SCROLL_BOTTOM_THRESHOLD;

    if (el.scrollTop < LOAD_MORE_THRESHOLD && this.hasMore() && !this.loadingMore()) {
      this.savedScrollHeight = el.scrollHeight;
      this.restoreScroll     = true;
      this.messageStore.loadMoreForChannel(this.channel().id);
    }
  }

  private scrollToBottom(): void {
    if (!this.scrollRef) return;
    const el = this.scrollRef.nativeElement;
    el.scrollTop = el.scrollHeight;
  }

  // ── Search actions ───────────────────────────────────────────────────────

  protected onSearchInput(value: string): void {
    this.searchQuery.set(value);
    this.searchSubject.next(value);
  }

  protected clearSearch(): void {
    this.searchQuery.set('');
    this.messageStore.clearChannelSearch(this.channel().id);
  }

  protected jumpToMessage(messageId: string): void {
    this.clearSearch();
    setTimeout(() => {
      const el = this.scrollRef?.nativeElement.querySelector(`[data-message-id="${messageId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('msg-highlight');
        setTimeout(() => el.classList.remove('msg-highlight'), 2000);
      }
    }, 50);
  }

  protected retryLoad(): void {
    this.messageStore.clearChannelError(this.channel().id);
    this.messageStore.loadForChannel(this.channel().id);
  }

  protected onReply(msg: MessageDto): void {
    this.replyingTo.set(msg);
    setTimeout(() => this.composerRef?.focus(), 0);
  }

  protected onCancelReply(): void {
    this.replyingTo.set(null);
  }

  protected getSnippet(encoded: string): string {
    return decodeContent(encoded);
  }

  protected getAuthorName(authorId: string): string {
    if (authorId === this.profileService.ownProfile()?.userId) return 'You';
    return this.profileService.getCachedByUserId(authorId)?.userName ?? 'Unknown';
  }

  protected fileIcon(contentType: string): string {
    if (contentType.startsWith('video/')) return 'pi-video';
    if (contentType.startsWith('audio/')) return 'pi-volume-up';
    if (contentType === 'application/pdf') return 'pi-file-pdf';
    if (contentType.includes('zip') || contentType.includes('rar')) return 'pi-folder';
    if (contentType.startsWith('text/')) return 'pi-file-edit';
    return 'pi-file';
  }

  // ── Message actions ──────────────────────────────────────────────────────

  public createMessage(event: { content: string; attachments: string[]; inReplyTo?: string }): void {
    const { content, attachments, inReplyTo } = event;
    const tempId = crypto.randomUUID();
    const now    = new Date();

    this.replyingTo.set(null);

    const optimistic: MessageDto = {
      id:             tempId,
      content:        btoa(encodeURIComponent(content).replace(/%([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))),
      channelId:      this.channel().id,
      conversationId: undefined,
      authorId:       this.profileService.ownProfile()?.userId ?? '',
      createdAt:      now,
      updatedAt:      now,
      isPending:      true,
      isFailed:       false,
      attachments:    [],
      inReplyTo,
    };

    this.messageStore.addMessage(optimistic);

    this.messagingService.createMessage({
      content,
      channelId:      this.channel().id,
      conversationId: undefined,
      attachments,
      inReplyTo,
    }).pipe(
      tap(confirmed => {
        this.messageStore.confirmMessage(tempId, confirmed);
        this.messagingService.messageSentObservable.next(confirmed);
      }),
      catchError(() => {
        this.messageStore.failMessage(tempId);
        return EMPTY;
      }),
    ).subscribe();
  }
}
