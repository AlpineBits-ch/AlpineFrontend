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
import { NgClass } from '@angular/common';
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

const SCROLL_BOTTOM_THRESHOLD = 100;
const LOAD_MORE_THRESHOLD     = 150;

@Component({
  selector: 'app-conversation',
  imports: [
    ComposerComponent, MessageComponent, Avatar, Button,
    CallPanelComponent, NgClass,
    UserStatusDotComponent, TypingDotsComponent,
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

  protected friends       = toSignal(this.relationshipService.getRelationships(), { initialValue: [] });
  protected chatTitle     = computed(() => this.convUtils.getChatTitle(this.conversation()));
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

  // ── Scroll state ─────────────────────────────────────────────────────────

  @ViewChild('messageScroll') private scrollRef!: ElementRef<HTMLDivElement>;
  private isNearBottom     = true;
  private savedScrollHeight = 0;
  private restoreScroll    = false;
  private lastScrollConvId = '';

  // ── Lifecycle ────────────────────────────────────────────────────────────

  constructor() {
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
        // setTimeout ensures the new message node is in the DOM before we scroll.
        setTimeout(() => this.scrollToBottom(), 0);
      }
    });

    // Only used to restore scroll position after loading older messages.
    afterEveryRender(() => {
      if (this.restoreScroll && this.scrollRef) {
        const el = this.scrollRef.nativeElement;
        const heightDiff = el.scrollHeight - this.savedScrollHeight;
        if (heightDiff > 0) el.scrollTop += heightDiff;
        this.restoreScroll    = false;
        this.savedScrollHeight = 0;
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

  // ── Actions ──────────────────────────────────────────────────────────────

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

  public createMessage(event: { content: string; attachments: string[] }): void {
    const { content, attachments } = event;
    const tempId = crypto.randomUUID();
    const now    = new Date();

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
