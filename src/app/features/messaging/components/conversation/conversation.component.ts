import {
  afterEveryRender,
  AfterViewInit,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  ViewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DatePipe, NgClass } from '@angular/common';
import { catchError, EMPTY, tap } from 'rxjs';

import { ConversationDto } from '../../../../dtos/response/conversation.dto';
import { MessageDto } from '../../../../dtos/response/message.dto';
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

import { ConversationSearchService } from './conversation-search.service';
import { ConversationScrollService } from './conversation-scroll.service';
import { decodeContent, fileIcon } from './message-utils';

@Component({
  selector: 'app-conversation',
  providers: [ConversationSearchService, ConversationScrollService],
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

  private messageStore     = inject(MessageStore);
  private messagingService  = inject(MessagingService);
  private profileService   = inject(ProfileService);
  private relationshipService = inject(RelationshipService);
  private callStateService   = inject(CallStateService);
  private callSessionService  = inject(CallSessionService);
  private messagingWs      = inject(MessagingWebsocketService);
  protected convUtils      = inject(ConversationUtilsService);

  protected search = inject(ConversationSearchService);
  protected scroll = inject(ConversationScrollService);

  protected readonly OnlineStatus = OnlineStatus;

  // ── View refs ─────────────────────────────────────────────────────────────

  @ViewChild('messageScroll') private scrollRef!: ElementRef<HTMLDivElement>;
  @ViewChild('messageList')   private messageListRef?: ElementRef<HTMLDivElement>;
  @ViewChild(ComposerComponent) private composerRef?: ComposerComponent;

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
  protected partnerStatus   = computed(() => this.convUtils.getPartnerStatus(this.conversation()));
  protected typingText      = computed(() => this.convUtils.getTypingLabel(this.conversation()));

  // ── Messages ─────────────────────────────────────────────────────────────

  protected messages = computed(() =>
    this.messageStore
      .entities()
      .filter(m => m.conversationId === this.conversation().id)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  );

  // The most recent confirmed message — watch this to react to incoming messages.
  protected latestMessage = computed(() => {
    const confirmed = this.messages().filter(m => !m.isPending && !m.isFailed);
    return confirmed.at(-1) ?? null;
  });

  // ── Load state ───────────────────────────────────────────────────────────

  private conversationMeta = computed(() =>
    this.messageStore.conversationMeta()[this.conversation().id] ?? null
  );

  // True until the first batch of messages arrives (or an error occurs).
  protected isInitialLoading = computed(() => this.conversationMeta() == null);
  protected isLoaded         = computed(() => {
    const meta = this.conversationMeta();
    return meta != null && !meta.loadingMore && meta.error == null;
  });
  protected hasMore     = computed(() => this.conversationMeta()?.hasMore ?? false);
  protected loadingMore = computed(() => this.conversationMeta()?.loadingMore ?? false);
  protected loadError   = computed(() => this.conversationMeta()?.error ?? null);

  // ── Lifecycle ────────────────────────────────────────────────────────────

  constructor() {
    this.setupMessageLoading();
    this.setupSearchSync();
    this.setupScrollBehavior();
    this.setupComposerFocus();
    this.setupRenderHook();
    this.setupReadTracking();
  }

  ngAfterViewInit(): void {
    this.scroll.attach(this.scrollRef.nativeElement);
    this.scroll.scrollToBottom();
  }

  // Triggers a (re)load whenever the active conversation changes.
  private setupMessageLoading(): void {
    effect(() => {
      this.messageStore.loadForConversation(this.conversation().id);
    });
  }

  // Keeps the search service in sync with the active conversation ID.
  private setupSearchSync(): void {
    effect(() => {
      this.search.conversationId.set(this.conversation().id);
    }, { allowSignalWrites: true });
  }

  // Keeps the scroll position correct on conversation switch and new messages.
  private setupScrollBehavior(): void {
    effect(() => {
      const convId = this.conversation().id;
      const _msgs  = this.messages();

      if (convId !== this.scroll.lastConvId) {
        this.scroll.lastConvId = convId;
        this.scroll.onConversationSwitch();
      }
      this.scroll.markNewMessages();
    });
  }

  // Re-focuses the composer whenever the active conversation changes.
  private setupComposerFocus(): void {
    effect(() => {
      const _conv = this.conversation();
      setTimeout(() => this.composerRef?.focus(), 0);
    });
  }

  // Notifies the backend whenever the latest confirmed message changes.
  private setupReadTracking(): void {
    effect(() => {
      const msg = this.latestMessage();
      if (msg) {
        void this.messagingWs.updateLastReadMessageByConversation(msg.id, this.conversation().id);
      }
    });
  }

  // Delegates post-render work (scroll restore, ResizeObserver update) to the scroll service.
  private setupRenderHook(): void {
    afterEveryRender(() => {
      this.scroll.onRender(this.messageListRef?.nativeElement);
    });
  }

  // ── Event handlers ───────────────────────────────────────────────────────

  protected onScroll(): void {
    this.scroll.onScroll(
      this.hasMore(),
      this.loadingMore(),
      () => this.messageStore.loadMoreForConversation(this.conversation().id),
    );
  }

  protected jumpToMessage(messageId: string): void {
    this.search.clear();
    // Delay until the message list re-renders after clearing search.
    setTimeout(() => this.scroll.jumpToMessage(messageId), 50);
  }

  protected retryLoad(): void {
    this.messageStore.clearConversationError(this.conversation().id);
    this.messageStore.loadForConversation(this.conversation().id);
  }

  protected onReply(msg: MessageDto): void {
    this.replyingTo.set(msg);
    setTimeout(() => this.composerRef?.focus(), 0);
  }

  protected onCancelReply(): void { this.replyingTo.set(null); }

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

  // ── Template helpers ─────────────────────────────────────────────────────

  protected getSnippet(encoded: string): string { return decodeContent(encoded); }

  protected fileIcon(contentType: string): string { return fileIcon(contentType); }

  protected getAuthorName(authorId: string): string {
    if (authorId === this.profileService.ownProfile()?.userId) return 'You';
    const member = this.conversation().members.find(m => m.userId === authorId);
    return member?.cachedUserName ?? 'Unknown';
  }

  // ── Message creation ─────────────────────────────────────────────────────

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
