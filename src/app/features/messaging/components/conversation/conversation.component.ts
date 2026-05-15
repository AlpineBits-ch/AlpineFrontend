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
  untracked,
  ViewChild,
} from '@angular/core';
import { DatePipe, NgClass } from '@angular/common';
import { catchError, EMPTY, from, switchMap, tap } from 'rxjs';

import { ConversationDto } from '../../../../dtos/response/conversation.dto';
import { ConversationEncryption } from '../../../../enums/conversation-encryption.enum';
import { MessageDto } from '../../../../dtos/response/message.dto';
import { MessageEncryptionState } from '../../../../enums/message-encryption-state.enum';
import { MessageType } from '../../../../enums/message-type.enum';
import { OnlineStatus } from '../../../../dtos/response/profile.dto';

import { Avatar } from 'primeng/avatar';
import { Button } from 'primeng/button';

import { MessagingService } from '../../../../services/messaging.service';
import { MlsService } from '../../../../services/mls.service';
import { MessageStore } from '../../../../stores/message.store';
import { ConversationStore } from '../../../../stores/conversation.store';
import { ProfileService } from '../../../../services/profile.service';
import { CallStateService } from '../../../../services/call-state.service';
import { CallSessionService } from '../../../../services/call-session.service';
import { MessagingWebsocketService } from '../../../../services/messaging-websocket.service';
import { ConversationUtilsService } from '../../../../services/conversation-utils.service';

import { ComposerComponent } from './composer/composer.component';
import { MentionCandidate } from './composer/composer-utils';
import { MessageComponent } from './message/message.component';
import { CallPanelComponent } from './call-panel/call-panel.component';
import { UserStatusDotComponent } from '../../../../components/user-status-dot/user-status-dot.component';
import { TypingDotsComponent } from '../../../../components/typing-dots/typing-dots.component';
import { HighlightPipe } from '../../../../pipes/highlight.pipe';
import { AppAvatarComponent } from '../../../../components/avatar/avatar.component';

import { ConversationSearchService } from './conversation-search.service';
import { ConversationScrollService } from './conversation-scroll.service';
import { ProfileDialogService } from '../../../../services/profile-dialog.service';
import { decodeContent, fileIcon } from './message-utils';
import {toBase64} from "../../../../helpers/base64.helper";
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-conversation',
  providers: [ConversationSearchService, ConversationScrollService],
  imports: [
    ComposerComponent, MessageComponent, Avatar, Button,
    CallPanelComponent, NgClass, DatePipe,
    UserStatusDotComponent, TypingDotsComponent, HighlightPipe,
    TranslateModule, AppAvatarComponent,
  ],
  templateUrl: './conversation.component.html',
  styleUrl: './conversation.component.css',
})
export class ConversationComponent implements AfterViewInit {
  public conversation = input.required<ConversationDto>();
  public back = output();

  private messageStore       = inject(MessageStore);
  private conversationStore  = inject(ConversationStore);
  private messagingService   = inject(MessagingService);
  private mlsService         = inject(MlsService);
  private profileService   = inject(ProfileService);
  private callStateService   = inject(CallStateService);
  private callSessionService  = inject(CallSessionService);
  private messagingWs      = inject(MessagingWebsocketService);
  protected convUtils      = inject(ConversationUtilsService);

  protected search = inject(ConversationSearchService);
  protected scroll = inject(ConversationScrollService);
  protected profileDialogSvc = inject(ProfileDialogService);

  protected readonly OnlineStatus = OnlineStatus;
  protected readonly ConversationEncryption = ConversationEncryption;

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

  protected replyingTo      = signal<MessageDto | null>(null);
  protected conversationMemberCandidates = computed<MentionCandidate[]>(() => {
    const ownId = this.profileService.ownProfile()?.userId;
    return this.conversation().members
      .filter(m => m.userId !== ownId)
      .map(m => ({ userId: m.userId, userName: m.cachedUserName, hash: m.cachedUserHash }));
  });
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

  // ── Unread state ─────────────────────────────────────────────────────────

  // ID of the first unread message when the conversation was opened.
  // Snapped once per conversation visit so the divider doesn't jump as you read.
  protected firstUnreadId = signal<string | null>(null);
  private _snappedForConvId = '';

  // ── Lifecycle ────────────────────────────────────────────────────────────

  constructor() {
    this.setupMessageLoading();
    this.setupSearchSync();
    this.setupScrollBehavior();
    this.setupComposerFocus();
    this.setupRenderHook();
    this.setupReadTracking();
    this.setupFirstUnreadSnapshot();
  }

  ngAfterViewInit(): void {
    this.scroll.attach(this.scrollRef.nativeElement);
    this.scroll.scrollToBottom();
  }

  // Triggers a (re)load whenever the active conversation changes.
  private setupMessageLoading(): void {
    effect(() => {
      const id = this.conversation().id;
      untracked(() => this.messageStore.loadForConversation(id));
    });
  }

  // Keeps the search service in sync with the active conversation ID.
  private setupSearchSync(): void {
    effect(() => {
      this.search.conversationId.set(this.conversation().id);
    });
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

  // Notifies the backend and updates the local store whenever the latest confirmed message changes.
  private setupReadTracking(): void {
    effect(() => {
      const msg    = this.latestMessage();
      const convId = this.conversation().id;
      const ownId  = this.profileService.ownProfile()?.userId;
      if (!msg || !ownId) return;
      // untracked: updateMemberLastRead reads entityMap() internally; tracking it would
      // make this effect a dependency of conversationStore and create an infinite loop
      // (write → entityMap changes → effect re-runs → write → ...).
      untracked(() => {
        void this.messagingWs.updateLastReadMessageByConversation(msg.id, convId);
        this.conversationStore.updateMemberLastRead(convId, ownId, msg.id);
      });
    });
  }

  // Snapshots the first unread message ID once when each conversation's messages
  // first load. Reads from the stable conversation() input (nav service snapshot)
  // so the divider position is unaffected by subsequent read-receipt store updates.
  private setupFirstUnreadSnapshot(): void {
    effect(() => {
      const convId = this.conversation().id;
      const loaded = this.isLoaded();
      const msgs   = this.messages();

      if (convId !== this._snappedForConvId) {
        this.firstUnreadId.set(null);
        if (!loaded) return;

        this._snappedForConvId = convId;

        const ownId     = this.profileService.ownProfile()?.userId;
        const ownMember = this.conversation().members.find(m => m.userId === ownId);
        const lastReadId = ownMember?.lastReadMessageId;

        if (lastReadId) {
          const confirmed = msgs.filter(m => !m.isPending && !m.isFailed);
          const readIdx   = confirmed.map(m => m.id).lastIndexOf(lastReadId);
          this.firstUnreadId.set(
            readIdx >= 0 && readIdx < confirmed.length - 1
              ? confirmed[readIdx + 1].id
              : null
          );
        }
      }
    });
  }

  // Delegates post-render work (scroll restore, ResizeObserver update) to the scroll service.
  // Also passes the scroll container element so the service stays current after error→retry
  // cycles where Angular re-creates the #messageScroll element inside the @else block.
  private setupRenderHook(): void {
    afterEveryRender(() => {
      this.scroll.onRender(
        this.messageListRef?.nativeElement,
        this.scrollRef?.nativeElement,
      );
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

  public createMessage(event: { content: string; attachments: string[]; inReplyTo?: string; mentions: string[] }): void {
    if (this.conversation().encryptionState === ConversationEncryption.Encrypted) {
      this.createEncryptedMessage(event);
    } else {
      this.createPlainMessage(event);
    }
  }

  private createPlainMessage(event: { content: string; attachments: string[]; inReplyTo?: string; mentions: string[] }): void {
    const { content, attachments, inReplyTo, mentions } = event;
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
      mentions,
      encryptionState: MessageEncryptionState.Plain,
      mlsEpoch:        undefined,
      mlsSequenceNumber: undefined,
      senderDeviceId:  undefined,
      type:            MessageType.Message,
    };

    this.messageStore.addMessage(optimistic);

    this.messagingService.createMessage({
      content,
      channelId:      undefined,
      conversationId: this.conversation().id,
      attachments,
      inReplyTo,
      mentions,
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

  private createEncryptedMessage(event: { content: string; attachments: string[]; inReplyTo?: string; mentions: string[] }): void {
    const { content, attachments, inReplyTo, mentions } = event;
    const tempId = crypto.randomUUID();
    const now    = new Date();
    const b64Content = toBase64(content);

    console.log('Creating encrypted message with content:', content);
    this.replyingTo.set(null);

    const optimistic: MessageDto = {
      id:              tempId,
      content:         b64Content,
      conversationId:  this.conversation().id,
      channelId:       undefined,
      authorId:        this.profileService.ownProfile()?.userId ?? '',
      createdAt:       now,
      updatedAt:       now,
      isPending:       true,
      isFailed:        false,
      attachments:     [],
      inReplyTo,
      mentions,
      encryptionState: MessageEncryptionState.Encrypted,
      mlsEpoch:        undefined,
      mlsSequenceNumber: undefined,
      senderDeviceId:  undefined,
      type:            MessageType.Message,
    };

    this.messageStore.addMessage(optimistic);

    const keyHandle = this.mlsService.keyHandle();
    if (!keyHandle) {
      this.messageStore.failMessage(tempId);
      return;
    }

    const conversationId = this.conversation().id;

    from(this.mlsService.getGroupIdForConversation(conversationId)).pipe(
      switchMap(groupId => {
        if (!groupId) throw new Error(`No MLS group found for conversation ${conversationId}`);
        return this.mlsService.sendMessage(groupId, keyHandle, b64Content);
      }),
      switchMap(({ ciphertext, epoch }) =>
        from(this.mlsService.getOrCreateDeviceIdentifier()).pipe(
          switchMap(deviceId =>
            this.messagingService.createMessage({
              content:         ciphertext,
              channelId:       undefined,
              conversationId,
              attachments,
              inReplyTo,
              mentions,
              encryptionState: MessageEncryptionState.Encrypted,
              mlsEpoch:        epoch,
              senderDeviceId:  deviceId,
            })
          )
        )
      ),
      tap(confirmed => {
        // Keep the plaintext content for display — the server stores ciphertext,
        // but we already have the plaintext and don't need to re-decrypt our own message.
        // Cache it so it survives app restarts (MLS forward secrecy makes re-decryption impossible).
        void this.mlsService.cacheMessage(confirmed.id, b64Content);
        this.messageStore.confirmMessage(tempId, { ...confirmed, content: b64Content });
        this.messagingService.messageSentObservable.next({ ...confirmed, content: b64Content });
      }),
      catchError(err => {
        console.error('Failed to send encrypted message', err);
        this.messageStore.failMessage(tempId);
        return EMPTY;
      }),
    ).subscribe();
  }
}
