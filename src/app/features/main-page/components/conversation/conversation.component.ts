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
  ViewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ConversationDto } from '../../../../dtos/response/conversation.dto';
import { ComposerComponent } from './composer/composer.component';
import { MessageComponent } from './message/message.component';
import { Avatar } from 'primeng/avatar';
import { Button } from 'primeng/button';
import { MessagingService } from '../../../../services/messaging.service';
import { MessageStore } from '../../../../stores/message.store';
import { catchError, EMPTY, tap } from 'rxjs';
import { ProfileService } from '../../../../services/profile.service';
import { MessageDto } from '../../../../dtos/response/message.dto';
import { RelationshipService } from '../../../../services/relationship.service';
import { CallStateService } from '../../../../services/call-state.service';
import { CallSessionService } from '../../../../services/call-session.service';
import { CallPanelComponent } from './call-panel/call-panel.component';
import { MessagingWebsocketService } from '../../../../services/messaging-websocket.service';
import { TypingService } from '../../../../services/typing.service';

const SCROLL_BOTTOM_THRESHOLD = 100; // px from bottom — auto-scroll kicks in
const LOAD_MORE_THRESHOLD = 150;     // px from top — fetch older messages

@Component({
  selector: 'app-conversation',
  imports: [ComposerComponent, MessageComponent, Avatar, Button, CallPanelComponent],
  templateUrl: './conversation.component.html',
  styleUrl: './conversation.component.css',
})
export class ConversationComponent implements AfterViewInit {
  public conversation = input.required<ConversationDto>();
  public back = output();

  private messageStore = inject(MessageStore);
  private messagingService = inject(MessagingService);
  private profileService = inject(ProfileService);
  private relationshipService = inject(RelationshipService);
  private callStateService = inject(CallStateService);
  private callSessionService = inject(CallSessionService);
  private messagingWs = inject(MessagingWebsocketService);
  private typingService = inject(TypingService);

  protected activeCall = computed(() => {
    const s = this.callSessionService.session();
    return s?.conversationId === this.conversation().id ? s : null;
  });

  protected friends = toSignal(this.relationshipService.getRelationships(), { initialValue: [] });

  protected chatTitle = computed(() => {
    const ownId = this.profileService.ownProfile()?.userId;
    if (!ownId) return 'Loading…';
    const others = this.conversation().members.filter(m => m.userId !== ownId);
    if (others.length === 0) return 'Empty chat';
    if (others.length === 1) return `${others[0].cachedUserName}#${others[0].cachedUserHash}`;
    return others.map(m => m.cachedUserName).join(', ');
  });

  protected chatAvatarLabel = computed(() => {
    const ownId = this.profileService.ownProfile()?.userId;
    const others = this.conversation().members.filter(m => m.userId !== ownId);
    return (others[0]?.cachedUserName?.[0] ?? '?').toUpperCase();
  });

  protected typingText = computed(() => {
    const ownId = this.profileService.ownProfile()?.userId;
    const ids = [...(this.typingService.state().get(this.conversation().id) ?? [])].filter(id => id !== ownId);
    if (ids.length === 0) return null;
    const members = this.conversation().members;
    const names = ids.map(id => members.find(m => m.userId === id)?.cachedUserName ?? 'Someone');
    if (names.length === 1) return `${names[0]} is typing…`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
    return 'Several people are typing…';
  });

  @ViewChild('messageScroll') private scrollRef!: ElementRef<HTMLDivElement>;

  /** Whether the user is close enough to the bottom that we should auto-scroll on new messages */
  private isNearBottom = true;

  /** Saved scrollHeight before an older-message fetch, used to restore position after DOM update */
  private savedScrollHeight = 0;

  /** Set to true when we need to restore scroll position after older messages load */
  private restoreScroll = false;

  // ── Derived signals ──────────────────────────────────────────────────────

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

  private lastScrollConvId = '';
  /** Set by the messages effect; consumed and cleared by afterEveryRender. */
  private pendingScrollToBottom = false;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  constructor() {
    // Load messages when conversation changes
    effect(() => {
      this.messageStore.loadForConversation(this.conversation().id);
    });

    // Tracks message list changes — only schedules a scroll when content actually changes
    effect(() => {
      const convId = this.conversation().id;
      const _ = this.messages(); // track message list

      if (convId !== this.lastScrollConvId) {
        this.lastScrollConvId = convId;
        this.isNearBottom = true;
        this.restoreScroll = false;
      }

      if (this.isNearBottom) {
        this.pendingScrollToBottom = true;
      }
    });

    // afterEveryRender executes the pending scroll after the DOM is committed
    afterEveryRender(() => {
      if (this.restoreScroll && this.scrollRef) {
        const el = this.scrollRef.nativeElement;
        const heightDiff = el.scrollHeight - this.savedScrollHeight;
        if (heightDiff > 0) el.scrollTop += heightDiff;
        this.restoreScroll = false;
        this.savedScrollHeight = 0;
      } else if (this.pendingScrollToBottom) {
        this.scrollToBottom();
        this.pendingScrollToBottom = false;
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

    // Near the top → fetch older messages
    if (el.scrollTop < LOAD_MORE_THRESHOLD && this.hasMore() && !this.loadingMore()) {
      this.savedScrollHeight = el.scrollHeight;
      this.restoreScroll = true;
      this.messageStore.loadMoreForConversation(this.conversation().id);
    }
  }

  private scrollToBottom(): void {
    if (!this.scrollRef) return;
    const el = this.scrollRef.nativeElement;
    el.scrollTop = el.scrollHeight;
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  protected onTyping(): void {
    this.messagingWs.invokeStartTyping(this.conversation().id);
  }

  protected startCall(): void {
    const ownId = this.profileService.ownProfile()?.userId;
    const members = this.conversation().members.filter(m => m.userId !== ownId);
    this.callStateService.startCall(
      this.conversation().id,
      members.map(m => m.userId),
      this.chatTitle(),
      this.chatAvatarLabel(),
    );
  }

  public createMessage(event: { content: string; attachments: string[] }): void {
    const { content, attachments } = event;
    const tempId = crypto.randomUUID();
    const now = new Date();

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
    };

    this.messageStore.addMessage(optimistic);

    this.messagingService.createMessage({
      content,
      channelId:      undefined,
      conversationId: this.conversation().id,
      attachments,
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
