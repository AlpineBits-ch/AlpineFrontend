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
import { DatePipe, NgClass } from '@angular/common';
import { catchError, debounceTime, EMPTY, Subject, tap } from 'rxjs';

import { ConversationDto } from '../../../../dtos/response/conversation.dto';
import { MessageAttachment, MessageDto } from '../../../../dtos/response/message.dto';
import { OnlineStatus } from '../../../../dtos/response/profile.dto';

import { Avatar } from 'primeng/avatar';
import { Button } from 'primeng/button';

import { MessagingService } from '../../../../services/messaging.service';
import { MessageStore } from '../../../../stores/message.store';
import { ProfileService } from '../../../../services/profile.service';
import { RelationshipService } from '../../../../services/relationship.service';
import { CallStateService } from '../../../../services/call-state.service';
import { CallSessionService } from '../../../../services/call-session.service';
import { MessagingWebsocketService } from '../../../../services/messaging-websocket.service';
import { ConversationUtilsService } from '../../../../services/conversation-utils.service';

import { ComposerComponent } from './composer/composer.component';
import { MessageComponent } from './message/message.component';
import { CallPanelComponent } from './call-panel/call-panel.component';
import { UserStatusDotComponent } from '../../../../components/user-status-dot/user-status-dot.component';
import { TypingDotsComponent } from '../../../../components/typing-dots/typing-dots.component';
import { HighlightPipe } from '../../../../pipes/highlight.pipe';

const SCROLL_BOTTOM_THRESHOLD = 100;
const LOAD_MORE_THRESHOLD     = 150;

function decodeContent(encoded: string): string {
  try {
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

@Component({
  selector: 'app-conversation',
  imports: [
    ComposerComponent, MessageComponent, Avatar, Button,
    CallPanelComponent, NgClass, DatePipe,
    UserStatusDotComponent, TypingDotsComponent, HighlightPipe,
  ],
  templateUrl: './conversation.component.html',
  styleUrl: './conversation.component.css',
})
export class ConversationComponent implements AfterViewInit {
  public conversation = input.required<ConversationDto>();
  public back = output();

  private messageStore    = inject(MessageStore);
  private messagingService = inject(MessagingService);
  private profileService  = inject(ProfileService);
  private relationshipService = inject(RelationshipService);
  private callStateService  = inject(CallStateService);
  private callSessionService = inject(CallSessionService);
  private messagingWs     = inject(MessagingWebsocketService);
  protected convUtils     = inject(ConversationUtilsService);

  protected readonly OnlineStatus = OnlineStatus;

  // ── Call state ───────────────────────────────────────────────────────────

  protected activeCall = computed(() => {
    const s = this.callSessionService.session();
    return s?.conversationId === this.conversation().id ? s : null;
  });

  protected isRinging = computed(() => {
    const out = this.callStateService.outgoingCall();
    return out?.conversationId === this.conversation().id ? out : null;
  });

  // ── Conversation meta ────────────────────────────────────────────────────

  protected friends         = toSignal(this.relationshipService.getRelationships(), { initialValue: [] });
  protected replyingTo      = signal<MessageDto | null>(null);
  protected chatTitle       = computed(() => this.convUtils.getChatTitle(this.conversation()));
  protected chatAvatarLabel = computed(() => this.convUtils.getChatAvatarLabel(this.conversation()));
  protected partnerStatus = computed(() => this.convUtils.getPartnerStatus(this.conversation()));
  protected typingText    = computed(() => this.convUtils.getTypingLabel(this.conversation()));

  // ── Messages ─────────────────────────────────────────────────────────────

  protected messages = computed(() =>
    this.messageStore
      .entities()
      .filter(m => m.conversationId === this.conversation().id)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  );

  protected hasMore = computed(() =>
    this.messageStore.conversationMeta()[this.conversation().id]?.hasMore ?? false
  );

  protected loadingMore = computed(() =>
    this.messageStore.conversationMeta()[this.conversation().id]?.loadingMore ?? false
  );

  protected loadError = computed(() =>
    this.messageStore.conversationMeta()[this.conversation().id]?.error ?? null
  );

  // ── Search ───────────────────────────────────────────────────────────────

  private searchSubject = new Subject<string>();
  protected searchQuery = signal('');

  protected searchEntry = computed(() =>
    this.messageStore.searchEntries()[this.conversation().id] ?? null
  );
  protected isSearchActive = computed(() => this.searchQuery().trim().length > 0);
  protected isSearching    = computed(() => this.searchEntry()?.searching ?? false);

  protected msgResults = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    if (!q) return [];
    return (this.searchEntry()?.results ?? []).filter(m => {
      return decodeContent(m.content).toLowerCase().includes(q);
    });
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
  private lastScrollConvId      = '';
  private pendingScrollToBottom = false;
  private contentObserver       = new ResizeObserver(() => {
    if (this.isNearBottom) this.scrollToBottom();
  });
  private observedListEl?: HTMLDivElement;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  constructor() {
    inject(DestroyRef).onDestroy(() => this.contentObserver.disconnect());

    effect(() => {
      this.messageStore.loadForConversation(this.conversation().id);
    });

    effect(() => {
      const convId = this.conversation().id;
      const _ = this.messages();

      if (convId !== this.lastScrollConvId) {
        this.lastScrollConvId = convId;
        this.isNearBottom  = true;
        this.restoreScroll = false;
      }

      if (this.isNearBottom) {
        this.pendingScrollToBottom = true;
      }
    });

    effect(() => {
      const _ = this.conversation();
      setTimeout(() => this.composerRef?.focus(), 0);
    });

    // Clear search when switching conversations
    effect(() => {
      this.conversation().id;
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

      // Keep ResizeObserver pointed at the current message list element
      // (it may appear/disappear as search is toggled)
      const listEl = this.messageListRef?.nativeElement;
      if (listEl !== this.observedListEl) {
        this.contentObserver.disconnect();
        this.observedListEl = listEl;
        if (listEl) this.contentObserver.observe(listEl);
      }
    });

    this.searchSubject.pipe(
      debounceTime(300),
      takeUntilDestroyed(),
    ).subscribe(query => {
      if (query.trim()) {
        this.messageStore.searchInConversation(this.conversation().id, query);
      } else {
        this.messageStore.clearSearch(this.conversation().id);
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
      this.messageStore.loadMoreForConversation(this.conversation().id);
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
    this.messageStore.clearSearch(this.conversation().id);
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

  protected getSnippet(encoded: string): string {
    return decodeContent(encoded);
  }

  protected getAuthorName(authorId: string): string {
    if (authorId === this.profileService.ownProfile()?.userId) return 'You';
    const member = this.conversation().members.find(m => m.userId === authorId);
    return member ? `${member.cachedUserName}` : 'Unknown';
  }

  protected fileIcon(contentType: string): string {
    if (contentType.startsWith('video/')) return 'pi-video';
    if (contentType.startsWith('audio/')) return 'pi-volume-up';
    if (contentType === 'application/pdf') return 'pi-file-pdf';
    if (contentType.includes('zip') || contentType.includes('rar')) return 'pi-folder';
    if (contentType.startsWith('text/')) return 'pi-file-edit';
    return 'pi-file';
  }

  // ── Other actions ────────────────────────────────────────────────────────

  protected retryLoad(): void {
    this.messageStore.clearConversationError(this.conversation().id);
    this.messageStore.loadForConversation(this.conversation().id);
  }

  protected onReply(msg: MessageDto): void {
    this.replyingTo.set(msg);
    setTimeout(() => this.composerRef?.focus(), 0);
  }

  protected onCancelReply(): void {
    this.replyingTo.set(null);
  }

  protected onTyping(): void {
    this.messagingWs.invokeStartTyping(this.conversation().id);
  }

  protected cancelCall(): void { this.callStateService.cancelOutgoing(); }

  protected startCall(): void {
    const ownId   = this.profileService.ownProfile()?.userId;
    const members = this.conversation().members.filter(m => m.userId !== ownId);
    this.callStateService.startCall(
      this.conversation().id,
      members.map(m => m.userId),
      this.chatTitle(),
      this.chatAvatarLabel(),
    );
  }

  public createMessage(event: { content: string; attachments: string[]; inReplyTo?: string }): void {
    const { content, attachments, inReplyTo } = event;
    const tempId = crypto.randomUUID();
    const now    = new Date();

    this.replyingTo.set(null);

    const optimistic: MessageDto = {
      id:             tempId,
      content:        btoa(encodeURIComponent(content).replace(/%([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))),
      conversationId: this.conversation().id,
      channelId:      undefined,
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
      channelId:      undefined,
      conversationId: this.conversation().id,
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
