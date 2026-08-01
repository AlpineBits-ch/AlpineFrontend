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
import {DatePipe, NgClass} from '@angular/common';
import {catchError, EMPTY, firstValueFrom, from, tap} from 'rxjs';
import {HttpErrorResponse} from '@angular/common/http';

import {ConversationDto} from '../../../../dtos/response/conversation.dto';
import {ConversationEncryption} from '../../../../enums/conversation-encryption.enum';
import {MessageDto} from '../../../../dtos/response/message.dto';
import {MessageEncryptionState} from '../../../../enums/message-encryption-state.enum';
import {MessageType} from '../../../../enums/message-type.enum';
import {OnlineStatus} from '../../../../dtos/response/profile.dto';

import {Avatar} from 'primeng/avatar';
import {Button} from 'primeng/button';

import {MessagingService} from '../../../../services/messaging.service';
import {MlsService} from '../../../../services/mls.service';
import {MlsUnreadableBannerComponent} from '../../../../components/mls-unreadable-banner/mls-unreadable-banner.component';
import {MlsSyncService} from '../../../../services/mls-sync.service';
import {MessageStore} from '../../../../stores/message.store';
import {ConversationStore} from '../../../../stores/conversation.store';
import {ProfileService} from '../../../../services/profile.service';
import {CallStateService} from '../../../../services/call-state.service';
import {CallSessionService} from '../../../../services/call-session.service';
import {MessagingWebsocketService} from '../../../../services/messaging-websocket.service';
import {ConversationUtilsService} from '../../../../services/conversation-utils.service';

import {ComposerComponent} from './composer/composer.component';
import {MentionCandidate} from './composer/composer-utils';
import {MessageComponent} from './message/message.component';
import {CallPanelComponent} from './call-panel/call-panel.component';
import {UserStatusDotComponent} from '../../../../components/user-status-dot/user-status-dot.component';
import {TypingDotsComponent} from '../../../../components/typing-dots/typing-dots.component';
import {HighlightPipe} from '../../../../pipes/highlight.pipe';
import {AppAvatarComponent} from '../../../../components/avatar/avatar.component';

import {ConversationSearchService} from './conversation-search.service';
import {ConversationScrollService} from './conversation-scroll.service';
import {ProfileDialogService} from '../../../../services/profile-dialog.service';
import {decodeContent, fileIcon, isGroupedWithPrevious} from './message-utils';
import {toBase64} from "../../../../helpers/base64.helper";
import {TranslateModule} from '@ngx-translate/core';
import {PinnedMessagesPanelComponent} from '../pinned-messages-panel/pinned-messages-panel.component';

@Component({
    selector: 'app-conversation',
    providers: [ConversationSearchService, ConversationScrollService],
    imports: [
        ComposerComponent, MessageComponent, Avatar, Button,
        CallPanelComponent, NgClass, DatePipe,
        UserStatusDotComponent, TypingDotsComponent, HighlightPipe,
        TranslateModule, AppAvatarComponent, PinnedMessagesPanelComponent,
        MlsUnreadableBannerComponent,
    ],
    templateUrl: './conversation.component.html',
    styleUrl: './conversation.component.css',
})
export class ConversationComponent implements AfterViewInit {
    public conversation = input.required<ConversationDto>();
    public back = output();
    protected convUtils = inject(ConversationUtilsService);
    protected search = inject(ConversationSearchService);
    protected scroll = inject(ConversationScrollService);
    protected profileDialogSvc = inject(ProfileDialogService);
    protected readonly OnlineStatus = OnlineStatus;
    protected readonly ConversationEncryption = ConversationEncryption;
    protected replyingTo = signal<MessageDto | null>(null);
    protected showPinnedPanel = signal(false);
    protected chatTitle = computed(() => this.convUtils.getChatTitle(this.conversation()));
    protected chatAvatarLabel = computed(() => this.convUtils.getChatAvatarLabel(this.conversation()));
    protected partnerStatus = computed(() => this.convUtils.getPartnerStatus(this.conversation()));
    protected typingText = computed(() => this.convUtils.getTypingLabel(this.conversation()));
    // The most recent confirmed message -watch this to react to incoming messages.
    protected latestMessage = computed(() => {
        const confirmed = this.messages().filter(m => !m.isPending && !m.isFailed);
        return confirmed.at(-1) ?? null;
    });
    // Snapped once per conversation visit so the divider doesn't jump as you read.
    protected firstUnreadId = signal<string | null>(null);
    private messageStore = inject(MessageStore);

    // ── View refs ─────────────────────────────────────────────────────────────
    protected messages = computed(() =>
        this.messageStore
            .entities()
            .filter(m => m.conversationId === this.conversation().id)
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    );
    protected messageRows = computed(() => {
        const msgs = this.messages();
        return msgs.map((message, i) => ({
            message,
            isGrouped: isGroupedWithPrevious(message, msgs[i - 1]),
        }));
    });
    private conversationStore = inject(ConversationStore);
    private messagingService = inject(MessagingService);

    // ── Call state ───────────────────────────────────────────────────────────
    private mlsService = inject(MlsService);
    private mlsSync = inject(MlsSyncService);
    private profileService = inject(ProfileService);

    // ── Conversation meta ────────────────────────────────────────────────────
    protected conversationMemberCandidates = computed<MentionCandidate[]>(() => {
        const ownId = this.profileService.ownProfile()?.userId;
        return this.conversation().members
            .filter(m => m.userId !== ownId)
            .map((m): MentionCandidate => ({kind: 'user', userId: m.userId, userName: m.cachedUserName}));
    });
    private callStateService = inject(CallStateService);
    protected isRinging = computed(() => {
        const out = this.callStateService.outgoingCall();
        return out?.conversationId === this.conversation().id ? out : null;
    });
    private callSessionService = inject(CallSessionService);
    protected activeCall = computed(() => {
        const s = this.callSessionService.session();
        if (s?.conversationId !== this.conversation().id) return null;
        // We're the caller and the callee hasn't joined yet (session exists solely
        // because CallSessionService.join() wires up WebRTC listeners ahead of
        // acceptance) - keep showing the ringing banner instead of the full call
        // panel, which otherwise looked like a live call before anyone answered.
        // Participant count can't be used to detect "has answered" - the create-call
        // response already lists every invitee up front, connected or not - so
        // isRinging() (cleared only by a real ParticipantJoined/CallEnded event) is
        // the only reliable signal.
        if (this.isRinging()) return null;
        return s;
    });
    // Concrete evidence the call is still ringing and hasn't been answered -
    // ticks while the ringing banner is shown.
    protected ringElapsed = signal('0:00');
    private messagingWs = inject(MessagingWebsocketService);

    // ── Messages ─────────────────────────────────────────────────────────────
    @ViewChild('messageScroll') private scrollRef!: ElementRef<HTMLDivElement>;
    @ViewChild('messageList') private messageListRef?: ElementRef<HTMLDivElement>;

    // ── Load state ───────────────────────────────────────────────────────────
    @ViewChild(ComposerComponent) private composerRef?: ComposerComponent;
    private conversationMeta = computed(() =>
        this.messageStore.conversationMeta()[this.conversation().id] ?? null
    );
    // True until the first batch of messages arrives (or an error occurs).
    protected isInitialLoading = computed(() => this.conversationMeta() == null);
    protected isLoaded = computed(() => {
        const meta = this.conversationMeta();
        return meta != null && !meta.loadingMore && meta.error == null;
    });
    protected hasMore = computed(() => this.conversationMeta()?.hasMore ?? false);
    protected loadingMore = computed(() => this.conversationMeta()?.loadingMore ?? false);

    // ── Lifecycle ────────────────────────────────────────────────────────────

    // ── Unread state ─────────────────────────────────────────────────────────

    // ID of the first unread message when the conversation was opened.
    protected loadError = computed(() => this.conversationMeta()?.error ?? null);
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
        this.setupRingElapsedTimer();
    }

    ngAfterViewInit(): void {
        this.scroll.attach(this.scrollRef.nativeElement);
        this.scroll.scrollToBottom();
    }

    public createMessage(event: {
        content: string;
        attachments: string[];
        inReplyTo?: string;
        mentions: string[];
        roleMentions: string[];
        mentionsEveryone: boolean;
        mentionsHere: boolean;
    }): void {
        if (this.conversation().encryptionState === ConversationEncryption.Encrypted) {
            this.createEncryptedMessage(event);
        } else {
            this.createPlainMessage(event);
        }
    }

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

    // Snapshots the first unread message ID once when each conversation's messages
    // first load. Reads from the stable conversation() input (nav service snapshot)

    protected onCancelReply(): void {
        this.replyingTo.set(null);
    }

    // Delegates post-render work (scroll restore, ResizeObserver update) to the scroll service.
    // Also passes the scroll container element so the service stays current after error→retry

    protected onTyping(): void {
        this.messagingWs.invokeStartTyping(this.conversation().id);
    }

    // ── Event handlers ───────────────────────────────────────────────────────

    protected cancelCall(): void {
        this.callStateService.cancelOutgoing();
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

    protected getSnippet(encoded: string): string {
        return decodeContent(encoded);
    }

    protected fileIcon(contentType: string): string {
        return fileIcon(contentType);
    }

    protected getAuthorName(authorId: string): string {
        if (authorId === this.profileService.ownProfile()?.userId) return 'You';
        const member = this.conversation().members.find(m => m.userId === authorId);
        return member?.cachedUserName ?? 'Unknown';
    }

    // Triggers a (re)load whenever the active conversation changes.
    private setupMessageLoading(): void {
        effect(() => {
            const id = this.conversation().id;
            untracked(() => this.messageStore.loadForConversation(id));
        });
    }

    // Ticks ringElapsed while the ringing banner is shown for this conversation.
    private setupRingElapsedTimer(): void {
        effect((onCleanup) => {
            const ringing = this.isRinging();
            if (!ringing) return;
            const start = ringing.startedAt.getTime();
            const tick = () => {
                const elapsed = Math.floor((Date.now() - start) / 1000);
                const m = Math.floor(elapsed / 60);
                const sec = (elapsed % 60).toString().padStart(2, '0');
                this.ringElapsed.set(`${m}:${sec}`);
            };
            tick();
            const id = setInterval(tick, 1000);
            onCleanup(() => clearInterval(id));
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
            const _msgs = this.messages();

            if (convId !== this.scroll.lastConvId) {
                this.scroll.lastConvId = convId;
                this.scroll.onConversationSwitch();
            }
            this.scroll.markNewMessages();
        });
    }

    // ── Template helpers ─────────────────────────────────────────────────────

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
            const msg = this.latestMessage();
            const convId = this.conversation().id;
            const ownId = this.profileService.ownProfile()?.userId;
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

    // so the divider position is unaffected by subsequent read-receipt store updates.
    private setupFirstUnreadSnapshot(): void {
        effect(() => {
            const convId = this.conversation().id;
            const loaded = this.isLoaded();
            const msgs = this.messages();

            if (convId !== this._snappedForConvId) {
                this.firstUnreadId.set(null);
                if (!loaded) return;

                this._snappedForConvId = convId;

                const ownId = this.profileService.ownProfile()?.userId;
                const ownMember = this.conversation().members.find(m => m.userId === ownId);
                const lastReadId = ownMember?.lastReadMessageId;

                if (lastReadId) {
                    const confirmed = msgs.filter(m => !m.isPending && !m.isFailed);
                    const readIdx = confirmed.map(m => m.id).lastIndexOf(lastReadId);
                    this.firstUnreadId.set(
                        readIdx >= 0 && readIdx < confirmed.length - 1
                            ? confirmed[readIdx + 1].id
                            : null
                    );
                }
            }
        });
    }

    // ── Message creation ─────────────────────────────────────────────────────

    // cycles where Angular re-creates the #messageScroll element inside the @else block.
    private setupRenderHook(): void {
        afterEveryRender(() => {
            this.scroll.onRender(
                this.messageListRef?.nativeElement,
                this.scrollRef?.nativeElement,
            );
        });
    }

    private createPlainMessage(event: {
        content: string;
        attachments: string[];
        inReplyTo?: string;
        mentions: string[];
        roleMentions: string[];
        mentionsEveryone: boolean;
        mentionsHere: boolean;
    }): void {
        const {content, attachments, inReplyTo, mentions, roleMentions, mentionsEveryone, mentionsHere} = event;
        const tempId = crypto.randomUUID();
        const now = new Date();

        this.replyingTo.set(null);

        const optimistic: MessageDto = {
            id: tempId,
            content: btoa(encodeURIComponent(content).replace(/%([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))),
            conversationId: this.conversation().id,
            channelId: undefined,
            authorId: this.profileService.ownProfile()?.userId ?? '',
            createdAt: now,
            updatedAt: now,
            isPending: true,
            isFailed: false,
            attachments: [],
            inReplyTo,
            mentions,
            roleMentions,
            mentionsEveryone,
            mentionsHere,
            encryptionState: MessageEncryptionState.Plain,
            mlsEpoch: undefined,
            mlsSequenceNumber: undefined,
            senderDeviceId: undefined,
            type: MessageType.Message,
        };

        this.messageStore.addMessage(optimistic);

        this.messagingService.createMessage({
            content,
            channelId: undefined,
            conversationId: this.conversation().id,
            attachments,
            inReplyTo,
            mentions,
            roleMentions,
            mentionsEveryone,
            mentionsHere,
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

    private createEncryptedMessage(event: {
        content: string;
        attachments: string[];
        inReplyTo?: string;
        mentions: string[];
        roleMentions: string[];
        mentionsEveryone: boolean;
        mentionsHere: boolean;
    }): void {
        const {content, attachments, inReplyTo, mentions, roleMentions, mentionsEveryone, mentionsHere} = event;
        const tempId = crypto.randomUUID();
        const now = new Date();
        const b64Content = toBase64(content);

        console.log('Creating encrypted message with content:', content);
        this.replyingTo.set(null);

        const optimistic: MessageDto = {
            id: tempId,
            content: b64Content,
            conversationId: this.conversation().id,
            channelId: undefined,
            authorId: this.profileService.ownProfile()?.userId ?? '',
            createdAt: now,
            updatedAt: now,
            isPending: true,
            isFailed: false,
            attachments: [],
            inReplyTo,
            mentions,
            roleMentions,
            mentionsEveryone,
            mentionsHere,
            encryptionState: MessageEncryptionState.Encrypted,
            mlsEpoch: undefined,
            mlsSequenceNumber: undefined,
            senderDeviceId: undefined,
            type: MessageType.Message,
        };

        this.messageStore.addMessage(optimistic);

        const keyHandle = this.mlsService.keyHandle();
        if (!keyHandle) {
            this.messageStore.failMessage(tempId);
            return;
        }

        const conversationId = this.conversation().id;

        from(this.sendEncrypted(conversationId, keyHandle, b64Content, {
            attachments, inReplyTo, mentions, roleMentions, mentionsEveryone, mentionsHere,
        })).pipe(
            tap(confirmed => {
                // Keep the plaintext for display. The server stores ciphertext and MLS ratchets
                // forward only, so this is the one moment we can cache it - after this, our own
                // message is as unreadable to us as anyone else's would be.
                void this.mlsService.cacheMessage(confirmed.id, b64Content);
                this.messageStore.confirmMessage(tempId, {...confirmed, content: b64Content});
                this.messagingService.messageSentObservable.next({...confirmed, content: b64Content});
            }),
            catchError(err => {
                console.error('Failed to send encrypted message', err);
                this.messageStore.failMessage(tempId);
                return EMPTY;
            }),
        ).subscribe();
    }

    /**
     * Tries to get this device readable again, from the banner.
     *
     * Re-reads the conversation's state, which joins from any Welcome that is waiting and replays
     * the commits missed since - the common case, where the device was simply behind. It
     * deliberately does *not* mint a new signing key: that is what orphans a device from every
     * group it belongs to, and it is never the right response to "I could not read this".
     */
    protected async relinkDevice(): Promise<void> {
        const conversationId = this.conversation().id;
        try {
            await this.mlsSync.refreshState(conversationId, false);
        } catch (err) {
            console.error('Re-link attempt failed', conversationId, err);
        }
    }

    /**
     * Encrypts and posts, retrying once against refreshed state.
     *
     * The server refuses a message whose encryption does not match the context's - which is exactly
     * what happens when encryption was toggled while this client was composing. That is a stale
     * view, not a real failure, so it re-reads the state and sends again rather than surfacing an
     * error the user can do nothing about.
     */
    private async sendEncrypted(
        conversationId: string,
        keyHandle: string,
        b64Content: string,
        rest: {
            attachments: string[]; inReplyTo: string | undefined; mentions: string[];
            roleMentions: string[]; mentionsEveryone: boolean; mentionsHere: boolean;
        },
    ): Promise<MessageDto> {
        const deviceId = await this.mlsService.getOrCreateDeviceIdentifier();

        const attempt = async (): Promise<MessageDto> => {
            const generation = await this.mlsService.getKnownGeneration(conversationId);
            if (generation === null) throw new Error(`Conversation ${conversationId} is not encrypted here`);

            const groupId = await this.mlsService.getGroupId(conversationId, generation);
            if (!groupId) throw new Error(`No MLS group found for conversation ${conversationId}`);

            const {ciphertext, epoch} = await firstValueFrom(
                this.mlsService.sendMessage(groupId, keyHandle, b64Content),
            );

            return firstValueFrom(this.messagingService.createMessage({
                content: ciphertext,
                channelId: undefined,
                conversationId,
                ...rest,
                encryptionState: MessageEncryptionState.Encrypted,
                mlsEpoch: epoch,
                mlsGeneration: generation,
                senderDeviceId: deviceId,
            }));
        };

        try {
            return await attempt();
        } catch (err) {
            if (!(err instanceof HttpErrorResponse) || err.status !== 409) throw err;
            await this.mlsSync.refreshState(conversationId, false);
            return attempt();
        }
    }
}
