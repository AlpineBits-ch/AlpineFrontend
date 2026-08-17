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
    viewChild,
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
import {MlsJoinRequestReviewComponent} from '../../../../components/mls-join-request-review/mls-join-request-review.component';
import {MlsSyncService} from '../../../../services/mls-sync.service';
import {MlsJoinRequestService} from '../../../../services/mls-join-request.service';
import {MlsHealthService} from '../../../../services/mls-health.service';
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

import {ConversationSearchService} from './conversation-search.service';
import {ConversationScrollService} from './conversation-scroll.service';
import {ProfilePopoutService} from '../../../../services/profile-popout.service';
import {buildMessageRows, fileIcon, isSystemMessageType} from './message-utils';
import {DateDividerComponent} from './date-divider/date-divider.component';
import {SystemMessageComponent} from './message/system-message/system-message.component';
import {ConversationCallService} from '../../../../services/conversation-call.service';
import {readableContent, UNDECRYPTABLE_SHORT} from '../../../../helpers/message-content.helper';
import {toBase64} from '../../../../helpers/base64.helper';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {ToastService} from '../../../../services/toast.service';
import {describeRefusal} from '../../../../core/refusal-message';
import {PinnedMessagesPanelComponent} from '../pinned-messages-panel/pinned-messages-panel.component';
import {JumpToPresentComponent} from '../../../../components/jump-to-present/jump-to-present.component';
import {EditGroupModalComponent} from './edit-group-modal/edit-group-modal.component';
import {ConversationAvatarComponent} from '../conversation-avatar/conversation-avatar.component';

@Component({
    selector: 'app-conversation',
    providers: [ConversationSearchService, ConversationScrollService],
    imports: [
        ComposerComponent,
        MessageComponent,
        Avatar,
        Button,
        CallPanelComponent,
        NgClass,
        DatePipe,
        UserStatusDotComponent,
        TypingDotsComponent,
        HighlightPipe,
        TranslateModule,
        PinnedMessagesPanelComponent,
        MlsUnreadableBannerComponent,
        MlsJoinRequestReviewComponent,
        SystemMessageComponent,
        DateDividerComponent,
        JumpToPresentComponent,
        EditGroupModalComponent,
        ConversationAvatarComponent,
    ],
    templateUrl: './conversation.component.html',
    styleUrl: './conversation.component.css',
})
export class ConversationComponent implements AfterViewInit {
    public readonly conversation = input.required<ConversationDto>();
    /**
     * The input is the live store entity, so it gets a new object on every rename, read receipt and
     * incoming message. Anything that means "which conversation" reads this instead, or it re-runs
     * on all of them.
     */
    protected readonly conversationId = computed(() => this.conversation().id);
    public back = output();
    protected convUtils = inject(ConversationUtilsService);
    protected search = inject(ConversationSearchService);
    protected scroll = inject(ConversationScrollService);
    protected profilePopout = inject(ProfilePopoutService);
    protected readonly OnlineStatus = OnlineStatus;
    protected readonly ConversationEncryption = ConversationEncryption;
    protected readonly replyingTo = signal<MessageDto | null>(null);
    protected readonly showPinnedPanel = signal(false);
    protected readonly isSystemMessage = isSystemMessageType;
    protected readonly chatTitle = computed(() => this.convUtils.getChatTitle(this.conversation()));
    protected readonly chatAvatarLabel = computed(() =>
        this.convUtils.getChatAvatarLabel(this.conversation()),
    );
    protected readonly isGroup = computed(() => this.convUtils.isGroup(this.conversation()));
    protected readonly showGroupEdit = signal(false);
    protected readonly partnerStatus = computed(() => this.convUtils.getPartnerStatus(this.conversation()));
    protected readonly typingText = computed(() => this.convUtils.getTypingLabel(this.conversation()));
    // The most recent confirmed message: watch this to react to incoming messages.
    protected readonly latestMessage = computed(() => {
        const confirmed = this.messages().filter(m => !m.isPending && !m.isFailed);
        return confirmed.at(-1) ?? null;
    });
    // Snapped once per conversation visit so the divider doesn't jump as you read.
    protected readonly firstUnreadId = signal<string | null>(null);
    private messageStore = inject(MessageStore);

    // ── View refs ─────────────────────────────────────────────────────────────
    protected readonly messages = computed(() =>
        this.messageStore
            .entities()
            .filter(m => m.conversationId === this.conversationId())
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    );
    protected readonly messageRows = computed(() => buildMessageRows(this.messages()));
    private conversationStore = inject(ConversationStore);
    private messagingService = inject(MessagingService);

    // ── Call state ───────────────────────────────────────────────────────────
    private mlsService = inject(MlsService);
    private mlsSync = inject(MlsSyncService);
    private mlsHealth = inject(MlsHealthService);
    private joinRequests = inject(MlsJoinRequestService);
    /** What the last re-link attempt for this conversation achieved. */
    protected readonly relinkStatus = computed(() => this.joinRequests.statusOf(this.conversationId()));
    /** Display names for the admission review prompt, keyed by user id. */
    protected readonly participantNames = computed<Record<string, string>>(() =>
        Object.fromEntries(this.conversation().members.map(m => [m.userId, m.cachedUserName])),
    );
    private profileService = inject(ProfileService);

    // ── Conversation meta ────────────────────────────────────────────────────
    protected readonly conversationMemberCandidates = computed<MentionCandidate[]>(() => {
        const ownId = this.profileService.ownProfile()?.userId;
        return this.conversation()
            .members.filter(m => m.userId !== ownId)
            .map((m): MentionCandidate => ({kind: 'user', userId: m.userId, userName: m.cachedUserName}));
    });
    private callStateService = inject(CallStateService);
    /** An answer sent and not confirmed yet, from either way into a call. */
    protected readonly joiningCall = computed(
        () => this.callStateService.joiningConversationId() === this.conversationId(),
    );
    protected readonly isRinging = computed(() => {
        const out = this.callStateService.outgoingCall();
        return out?.conversationId === this.conversationId() ? out : null;
    });
    private callSessionService = inject(CallSessionService);
    protected readonly activeCall = computed(() => {
        const s = this.callSessionService.session();
        if (s?.conversationId !== this.conversationId()) return null;
        // A session exists before acceptance, so keep the ringing banner rather than the call panel.
        // Participant count cannot detect "has answered" (the create-call response lists every
        // invitee up front), so isRinging() is the only reliable signal.
        if (this.isRinging()) return null;
        return s;
    });
    /** Only exists while `activeCall()` does - see `CallPanelComponent.isFullView`. */
    private readonly callPanelRef = viewChild(CallPanelComponent);
    /**
     * Whether the docked call currently fills the content area, so the message column below it can
     * be collapsed - without that, `app-call-panel`'s own `flex-1` in full view would just split the
     * remaining space with this column instead of actually filling the container.
     */
    protected readonly isCallFullView = computed(() => this.callPanelRef()?.isFullView() ?? false);
    // Concrete evidence the call is still ringing and hasn't been answered -
    // ticks while the ringing banner is shown.
    protected readonly ringElapsed = signal('0:00');
    private conversationCalls = inject(ConversationCallService);
    /** Set by the header's camera button; consumed once the call session appears. */
    private enableCameraOnJoin = false;
    /** A call running in this conversation that this client is not on - see ConversationCallService. */
    protected readonly ongoingCall = computed(() => this.conversationCalls.ongoingIn(this.conversationId()));
    /** Who is on that call, named from the conversation roster. */
    protected readonly ongoingParticipantNames = computed(() => {
        const call = this.ongoingCall();
        if (!call) return '';
        const members = this.conversation().members;
        const names = call.connectedUserIds
            .map(id => members.find(m => m.userId === id)?.cachedUserName)
            .filter((name): name is string => !!name);
        return names.length > 0 ? names.join(', ') : this.chatTitle();
    });
    private messagingWs = inject(MessagingWebsocketService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    // ── Messages ─────────────────────────────────────────────────────────────
    @ViewChild('messageScroll') private scrollRef!: ElementRef<HTMLDivElement>;
    @ViewChild('messageList') private messageListRef?: ElementRef<HTMLDivElement>;

    // ── Load state ───────────────────────────────────────────────────────────
    @ViewChild(ComposerComponent) private composerRef?: ComposerComponent;
    private readonly conversationMeta = computed(
        () => this.messageStore.conversationMeta()[this.conversationId()] ?? null,
    );
    // True until the first batch of messages arrives (or an error occurs).
    protected readonly isInitialLoading = computed(() => this.conversationMeta() == null);
    protected readonly isLoaded = computed(() => {
        const meta = this.conversationMeta();
        return meta != null && !meta.loadingMore && meta.error == null;
    });
    protected readonly hasMore = computed(() => this.conversationMeta()?.hasMore ?? false);
    protected readonly loadingMore = computed(() => this.conversationMeta()?.loadingMore ?? false);

    // ── Lifecycle ────────────────────────────────────────────────────────────

    // ── Unread state ─────────────────────────────────────────────────────────

    // ID of the first unread message when the conversation was opened.
    protected readonly loadError = computed(() => this.conversationMeta()?.error ?? null);
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

    /** Composes, encrypting whenever this device has any reason to believe it must. */
    public async createMessage(event: {
        content: string;
        attachments: string[];
        inReplyTo?: string;
        mentions: string[];
        roleMentions: string[];
        mentionsEveryone: boolean;
        mentionsHere: boolean;
    }): Promise<void> {
        const conversationId = this.conversation().id;
        const serverSaysEncrypted = this.conversation().encryptionState === ConversationEncryption.Encrypted;

        if (serverSaysEncrypted) {
            this.createEncryptedMessage(event);
            return;
        }

        const floor = await this.mlsService.getEncryptionFloor(conversationId);
        if (floor !== null) {
            // Refused outright rather than downgraded. Nothing leaves the machine: the plaintext is
            // the part that cannot be taken back, so there is no version of this where sending and
            // apologising afterwards is better than not sending.
            this.mlsHealth.recordFailure(
                conversationId,
                false,
                'downgraded',
                `the server reports this conversation as unencrypted, but this device has held an ` +
                    `MLS group for it up to generation ${floor}`,
            );
            return;
        }

        this.createPlainMessage(event);
    }

    protected onScroll(): void {
        this.scroll.onScroll(this.hasMore(), this.loadingMore(), () =>
            this.messageStore.loadMoreForConversation(this.conversation().id),
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

    protected joinOngoingCall(callId: string): void {
        this.callStateService.joinOngoing(callId, this.conversation().id);
    }

    protected openGroupEdit(): void {
        this.showGroupEdit.set(true);
    }

    /** The camera button in the header. */
    protected startVideoCall(): void {
        if (this.callSessionService.session()) {
            void this.callSessionService.toggleCamera();
            return;
        }
        this.enableCameraOnJoin = true;
        this.startCall();
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

    /** Search-result snippet. */
    protected getSnippet(msg: MessageDto): string {
        return readableContent(msg, UNDECRYPTABLE_SHORT);
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
        // The camera can only be opened once there is a call to open it in, and the session appears
        // a round trip after the button was pressed. One-shot: a later hang-up-and-redial must not
        // inherit a video call nobody asked for this time.
        effect(() => {
            const session = this.callSessionService.session();
            if (!session || !this.enableCameraOnJoin) return;
            untracked(() => {
                this.enableCameraOnJoin = false;
                if (!session.local.isCameraOn) void this.callSessionService.toggleCamera();
            });
        });

        effect(() => {
            const id = this.conversationId();
            untracked(() => {
                this.messageStore.loadForConversation(id);
                // A call already running in here was announced before this conversation was
                // opened, and SignalR replays nothing - so it has to be asked for.
                this.conversationCalls.refresh(id);
            });
        });
    }

    // Ticks ringElapsed while the ringing banner is shown for this conversation.
    private setupRingElapsedTimer(): void {
        effect(onCleanup => {
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
            this.search.conversationId.set(this.conversationId());
        });
    }

    // Keeps the scroll position correct on conversation switch and new messages.
    private setupScrollBehavior(): void {
        effect(() => {
            const convId = this.conversationId();
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
            const _convId = this.conversationId();
            setTimeout(() => this.composerRef?.focus(), 0);
        });
    }

    // Notifies the backend and updates the local store whenever the latest confirmed message changes.
    private setupReadTracking(): void {
        effect(() => {
            const msg = this.latestMessage();
            const convId = this.conversationId();
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
            const convId = this.conversationId();
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
                        readIdx >= 0 && readIdx < confirmed.length - 1 ? confirmed[readIdx + 1].id : null,
                    );
                }
            }
        });
    }

    // ── Message creation ─────────────────────────────────────────────────────

    // cycles where Angular re-creates the #messageScroll element inside the @else block.
    private setupRenderHook(): void {
        afterEveryRender(() => {
            this.scroll.onRender(this.messageListRef?.nativeElement, this.scrollRef?.nativeElement);
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
        const {content, attachments, inReplyTo, mentions, roleMentions, mentionsEveryone, mentionsHere} =
            event;
        const tempId = crypto.randomUUID();
        const now = new Date();

        this.replyingTo.set(null);

        const optimistic: MessageDto = {
            id: tempId,
            content: btoa(
                encodeURIComponent(content).replace(/%([0-9A-F]{2})/gi, (_, hex) =>
                    String.fromCharCode(parseInt(hex, 16)),
                ),
            ),
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

        this.messagingService
            .createMessage({
                content,
                channelId: undefined,
                conversationId: this.conversation().id,
                attachments,
                inReplyTo,
                mentions,
                roleMentions,
                mentionsEveryone,
                mentionsHere,
            })
            .pipe(
                tap(confirmed => {
                    this.messageStore.confirmMessage(tempId, confirmed);
                    this.messagingService.messageSentObservable.next(confirmed);
                }),
                catchError(err => {
                    this.messageStore.failMessage(tempId);
                    this.explainSendFailure(err);
                    return EMPTY;
                }),
            )
            .subscribe();
    }

    /** Says why a send was refused, when the server gave a reason. */
    private explainSendFailure(err: unknown): void {
        const notice = describeRefusal(err);
        if (notice) this.toast.error(this.translate.instant(notice.messageKey));
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
        const {content, attachments, inReplyTo, mentions, roleMentions, mentionsEveryone, mentionsHere} =
            event;
        const tempId = crypto.randomUUID();
        const now = new Date();
        const b64Content = toBase64(content);

        // Never log here: this is the one path whose reason to exist is that the plaintext does not
        // leave the machine unencrypted, and release builds ship `devtools`.
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
        const ownUserId = this.profileService.ownProfile()?.userId;

        from(
            this.sendEncrypted(conversationId, keyHandle, b64Content, {
                attachments,
                inReplyTo,
                mentions,
                roleMentions,
                mentionsEveryone,
                mentionsHere,
            }),
        )
            .pipe(
                tap(({confirmed, generation}) => {
                    // MLS ratchets forward only, so this is the one moment the plaintext can be cached.
                    // Must key on the generation this message was sealed with, never
                    // `confirmed.mlsGeneration`: the cache key must not be something the server chooses.
                    void this.mlsService.cacheMessage(
                        conversationId,
                        generation,
                        confirmed.id,
                        b64Content,
                        ownUserId,
                    );
                    this.messageStore.confirmMessage(tempId, {...confirmed, content: b64Content});
                    this.messagingService.messageSentObservable.next({...confirmed, content: b64Content});
                }),
                catchError(err => {
                    console.error('Failed to send encrypted message', err);
                    this.messageStore.failMessage(tempId);
                    this.explainSendFailure(err);
                    return EMPTY;
                }),
            )
            .subscribe();
    }

    /** Tries to get this device readable again, from the banner. */
    protected async relinkDevice(): Promise<void> {
        await this.joinRequests.relink(this.conversation().id, false);
    }

    /** Encrypts and posts, retrying once against refreshed state. */
    private async sendEncrypted(
        conversationId: string,
        keyHandle: string,
        b64Content: string,
        rest: {
            attachments: string[];
            inReplyTo: string | undefined;
            mentions: string[];
            roleMentions: string[];
            mentionsEveryone: boolean;
            mentionsHere: boolean;
        },
    ): Promise<{confirmed: MessageDto; generation: number}> {
        const deviceId = await this.mlsService.getOrCreateDeviceIdentifier();

        // The generation travels back out with the confirmation because the plaintext cache is
        // keyed on it, and the only trustworthy source for "which generation was this sealed
        // under" is the one this device used to seal it.
        const attempt = async (): Promise<{confirmed: MessageDto; generation: number}> => {
            const generation = await this.mlsService.getKnownGeneration(conversationId);
            if (generation === null) throw new Error(`Conversation ${conversationId} is not encrypted here`);

            const groupId = await this.mlsService.getGroupId(conversationId, generation);
            if (!groupId) throw new Error(`No MLS group found for conversation ${conversationId}`);

            const {ciphertext, epoch} = await firstValueFrom(
                this.mlsService.sendMessage(groupId, keyHandle, b64Content),
            );

            const confirmed = await firstValueFrom(
                this.messagingService.createMessage({
                    content: ciphertext,
                    channelId: undefined,
                    conversationId,
                    ...rest,
                    encryptionState: MessageEncryptionState.Encrypted,
                    mlsEpoch: epoch,
                    mlsGeneration: generation,
                    senderDeviceId: deviceId,
                }),
            );
            return {confirmed, generation};
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
