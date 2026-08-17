import {inject, Injectable} from '@angular/core';
import {NotificationService, NotificationSound} from './notification.service';
import {catchError, concatMap, firstValueFrom, from, of, Subject, timeout} from 'rxjs';
import {MessageDto} from '../dtos/response/message.dto';
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';
import {MessageType} from '../enums/message-type.enum';
import {AttachmentDto} from './file.service';
import {CallStateChangedEvent} from '../dtos/response/ongoing-call.dto';
import {OnlineStatus} from '../dtos/response/profile.dto';
import {ProfileService} from './profile.service';
import {MlsService} from './mls.service';
import {MlsSyncService} from './mls-sync.service';
import {MlsHealthService} from './mls-health.service';
import {ConversationService} from './conversation.service';
import {fromBase64} from '../helpers/base64.helper';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';
import {PrivacySettingsService} from './privacy-settings.service';

// Re-exported for existing importers (connection-status, guild-websocket, …).
export {ConnectionState};

export interface MessageUpdatedEvent {
    messageId: string;
    content: string;
    authorId: string;
    conversationId: string | undefined;
    channelId: string | undefined;
    /** JSON-encoded `MessageEmbed[]`, or null when the message has none. */
    embedsJson?: string | null;
    /** Message bitfield; carries the suppress-embeds bit. */
    flags?: number;
    /** When the author last changed the text. Null when this update was not an author edit. */
    editedAt?: string | null;
    /** False for updates the author did not cause: a preview attaching, a suppression. */
    isAuthorEdit?: boolean;
}

export interface ConversationMemberRemoved {
    conversationId: string;
    userId: string;
    hasLeft: boolean;
}

export interface MessageDeletedEvent {
    messageId: string;
    conversationId: string | undefined;
    channelId: string | undefined;
}

export interface ConversationRemoved {
    conversationId: string;
}

/** A group conversation's name or icon changed. Sent to the member who made the change too. */
export interface ConversationUpdated {
    conversationId: string;
    name: string | null;
    iconUpdatedAt: string | null;
}

export interface UserTypingEvent {
    conversationId: string;
    userId: string;
}

export interface ReactionEvent {
    messageId: string;
    emoji: string;
    emojiId?: string;
    userId: string;
    channelId?: string;
    conversationId?: string;
}

export interface MessagePinnedEvent {
    messageId: string;
    conversationId?: string;
    channelId?: string;
    authorId: string;
    pinnedById: string;
    pinnedAt: string;
}

export interface MessageUnpinnedEvent {
    messageId: string;
    conversationId?: string;
    channelId?: string;
    authorId: string;
    unpinnedById: string;
}

/** Normalized "something happened to this context's MLS group" event. */
export interface MlsContextEvent {
    contextId: string;
    isChannel: boolean;
    generation: number;
}

/** A device asking into a context's MLS group (§B). Carries no key package: fetch `GET .../mls/join-requests`. */
export interface MlsJoinRequestEvent extends MlsContextEvent {
    requestId: string;
    requesterUserId: string;
    requesterDeviceId: string;
    /** The requesting device's self-chosen name. Display only: verified by nobody, nothing is authorized on it. */
    requesterDeviceName: string | null;
    /** The requester's long-lived identity fingerprint: the value a human compares out of band. */
    signatureKeyFingerprint: string;
    /** The server's published verdict on whether a human must tap approve (§J.4). */
    requiresManualApproval: boolean;
}

/** A nudge, not the commit: applying commits in push-arrival order forks the client permanently. */
interface MlsCommitPushPayload {
    contextId?: string;
    conversationId?: string | null;
    channelId?: string | null;
    generation: number;
    epoch: number;
    senderDeviceId: string;
}

/** Names the *removed* device as `userId`/`deviceId`, not `senderDeviceId` as every other MLS push does. */
interface MlsDeviceRemovedPushPayload {
    contextId?: string;
    conversationId?: string | null;
    channelId?: string | null;
    generation: number;
    epoch: number;
    /** The account whose device was removed, not the actor who removed it. */
    userId: string;
    /** The removed device's client device id. Unique only per account, so always match it with `userId`. */
    deviceId: string;
}

interface MlsJoinRequestPushPayload {
    contextId?: string;
    conversationId?: string | null;
    channelId?: string | null;
    generation: number;
    requestId: string;
    requesterUserId: string;
    requesterDeviceId: string;
    requesterDeviceName?: string | null;
    signatureKeyFingerprint: string;
    requiresManualApproval?: boolean;
}

interface MlsStateChangedPushPayload {
    contextId?: string;
    conversationId?: string | null;
    channelId?: string | null;
    encrypted: boolean;
    generation: number;
}

interface MessageCreatedPayload {
    messageId: string;
    /** The message's stored timestamp, not this device's receipt time. */
    createdAt?: string;
    content: string;
    authorId: string;
    conversationId: string;
    channelId: string | undefined;
    attachments: AttachmentDto[];
    inReplyTo: string | undefined;
    mentions: string[] | undefined;
    encryptionState: MessageEncryptionState | undefined;
    mlsGeneration: number | undefined;
    mlsEpoch: number | undefined;
    mlsSequenceNumber: number | undefined;
    senderDeviceId: string | undefined;
    embedsJson: string | undefined;
    /** Message bitfield. A message can arrive already suppressed: a restore, a backfill. */
    flags?: number;
    editedAt?: string | null;
}

/** Normalizes an MLS push. The kind comes from which id the payload carries, never from who is listening. */
export function toContextEvent(payload: {
    contextId?: string;
    conversationId?: string | null;
    channelId?: string | null;
    generation: number;
}): MlsContextEvent {
    return {
        contextId: payload.contextId ?? payload.conversationId ?? payload.channelId ?? '',
        isChannel: !!payload.channelId,
        generation: payload.generation,
    };
}

/** An absent `requiresManualApproval` fails closed to "a human decides" (§J.4), never to permissive. */
export function toJoinRequestEvent(payload: MlsJoinRequestPushPayload): MlsJoinRequestEvent {
    return {
        ...toContextEvent(payload),
        requestId: payload.requestId,
        requesterUserId: payload.requesterUserId,
        requesterDeviceId: payload.requesterDeviceId,
        requesterDeviceName: payload.requesterDeviceName ?? null,
        signatureKeyFingerprint: payload.signatureKeyFingerprint,
        requiresManualApproval: payload.requiresManualApproval ?? true,
    };
}

@Injectable({
    providedIn: 'root',
})
export class MessagingWebsocketService {
    public messageObservable = new Subject<MessageDto>();
    public messageUpdatedObservable = new Subject<MessageUpdatedEvent>();
    public messageDeletedObservable = new Subject<MessageDeletedEvent>();
    public conversationRemovedObservable = new Subject<ConversationRemoved>();
    public conversationUpdatedObservable = new Subject<ConversationUpdated>();
    public conversationMemberRemovedObservable = new Subject<ConversationMemberRemoved>();
    public userTypingObservable = new Subject<UserTypingEvent>();
    public userOnlineObservable = new Subject<string>();
    public userOfflineObservable = new Subject<string>();
    public conversationCreatedObservable = new Subject<string>();
    /** A call in one of our conversations started or ended. Addressed to every member, not just the roster. */
    public conversationCallStateObservable = new Subject<CallStateChangedEvent>();
    public welcomeObservable = new Subject<string>();
    /** A commit advanced a group we are in. Carries no commit bytes by design; see MlsSyncService. */
    public mlsCommitObservable = new Subject<MlsContextEvent>();
    /** Encryption was switched on or off for a context. */
    public mlsStateChangedObservable = new Subject<MlsContextEvent>();
    /** A device asked to be admitted to a context, and somebody has to review it. */
    public mlsJoinRequestObservable = new Subject<MlsJoinRequestEvent>();
    public reactionAddedObservable = new Subject<ReactionEvent>();
    public reactionRemovedObservable = new Subject<ReactionEvent>();
    public messagePinnedObservable = new Subject<MessagePinnedEvent>();
    public messageUnpinnedObservable = new Subject<MessageUnpinnedEvent>();
    private realtime = inject(RealtimeConnectionService);
    private privacy = inject(PrivacySettingsService);
    private notificationService = inject(NotificationService);
    private profileService = inject(ProfileService);
    private mlsService = inject(MlsService);
    private mlsSync = inject(MlsSyncService);
    private mlsHealth = inject(MlsHealthService);
    private conversationService = inject(ConversationService);
    private readonly _rawMessageCreated$ = new Subject<MessageCreatedPayload>();
    private listenersSetUp = false;
    // SignalR's automatic reconnect can redeliver 'conversation.MessageCreated' for an already-seen message.
    private readonly notifiedMessageIds = new Set<string>();

    constructor() {
        this._rawMessageCreated$.pipe(concatMap(data => from(this.handleMessageCreated(data)))).subscribe();
    }

    /** Shared connection state: one connection backs every feature. */
    get connectionState() {
        return this.realtime.connectionState;
    }

    async start(): Promise<void> {
        if (!this.listenersSetUp) {
            this.listenersSetUp = true;
            this.setupListeners();
        }
        await this.realtime.start();
    }

    async updateLastReadMessageByConversation(id: string, conversationId: string) {
        await this.realtime.invoke('conversation.UpdateLastRead', {conversationId, id});
    }

    /** Announces that the user is typing. Suppressed when the account has typing indicators off (T2-18). */
    invokeStartTyping(conversationId: string): void {
        if (!this.privacy.sendTypingIndicators()) return;
        void this.realtime.invoke('conversation.StartTyping', conversationId);
    }

    private setupListeners(): void {
        // Friend requests moved to the `social.*` events; see SocialWebsocketService and RelationshipStore.
        this.realtime.on('conversation.MessageUpdated', async (data: MessageUpdatedEvent) => {
            // Not logged: `content` is the edited body, plaintext, and this console ships in release builds.
            this.messageUpdatedObservable.next(data);
        });

        this.realtime.on('conversation.MessageDeleted', async (data: MessageDeletedEvent) => {
            this.messageDeletedObservable.next(data);
        });

        this.realtime.on('conversation.ConversationDeleted', async (data: ConversationRemoved) => {
            console.log('Conversation removed:', data);
            this.conversationRemovedObservable.next(data);
        });
        this.realtime.on('conversation.ConversationUpdated', (data: ConversationUpdated) => {
            this.conversationUpdatedObservable.next(data);
        });
        this.realtime.on('conversation.MemberLeft', async (data: ConversationMemberRemoved) => {
            console.log('Conversation member removed:', data);
            this.conversationMemberRemovedObservable.next(data);
        });

        this.realtime.on('conversation.UserTyping', (data: UserTypingEvent) => {
            this.userTypingObservable.next(data);
        });

        this.realtime.on('presence.UserOnline', async (str: string) => {
            this.userOnlineObservable.next(str);
            this.profileService.setOnlineStatus(str, OnlineStatus.Online);
        });

        this.realtime.on('presence.UserOffline', async (str: string) => {
            this.userOfflineObservable.next(str);
            this.profileService.setOnlineStatus(str, OnlineStatus.Offline);
        });

        this.realtime.on('conversation.MessageCreated', (data: MessageCreatedPayload) => {
            this._rawMessageCreated$.next(data);
        });

        this.realtime.on('conversation.CallStateChanged', (data: CallStateChangedEvent) => {
            this.conversationCallStateObservable.next(data);
        });

        this.realtime.on('conversation.ConversationCreated', (conversationId: string) => {
            console.log('ConversationCreated:', conversationId);
            this.conversationCreatedObservable.next(conversationId);
        });

        // A channel commit must never be taken to imply conversation membership.
        this.realtime.on('conversation.MlsCommit', (payload: MlsCommitPushPayload) => {
            this.mlsCommitObservable.next(toContextEvent(payload));
        });

        // Nothing is applied here: this only prompts the ordered catch-up that discovers the removal.
        this.realtime.on('conversation.MlsDeviceRemoved', (payload: MlsDeviceRemovedPushPayload) => {
            this.mlsCommitObservable.next(toContextEvent(payload));
        });

        // A prompt only: the membership change itself arrives as a commit through the ordered fetch.
        this.realtime.on('conversation.MlsDeviceAdmitted', (payload: MlsCommitPushPayload) => {
            this.mlsCommitObservable.next(toContextEvent(payload));
        });

        // Nothing is decided here: the payload carries no key package, so the review surface re-reads the queue.
        this.realtime.on('conversation.MlsJoinRequest', (payload: MlsJoinRequestPushPayload) => {
            this.mlsJoinRequestObservable.next(toJoinRequestEvent(payload));
        });

        this.realtime.on('conversation.MlsStateChanged', (payload: MlsStateChangedPushPayload) => {
            this.mlsStateChangedObservable.next(toContextEvent(payload));
        });

        this.realtime.on('conversation.Welcome', (conversationId: string) => {
            console.log('Welcome for conversation:', conversationId);
            this.welcomeObservable.next(conversationId);
        });

        this.realtime.on('conversation.ReactionCreated', (data: ReactionEvent) => {
            this.reactionAddedObservable.next(data);
        });

        this.realtime.on('conversation.ReactionRemoved', (data: ReactionEvent) => {
            this.reactionRemovedObservable.next(data);
        });

        this.realtime.on('conversation.MessagePinned', (data: MessagePinnedEvent) => {
            this.messagePinnedObservable.next(data);
        });

        this.realtime.on('conversation.MessageUnpinned', (data: MessageUnpinnedEvent) => {
            this.messageUnpinnedObservable.next(data);
        });
    }

    private async handleMessageCreated(data: MessageCreatedPayload): Promise<void> {
        const encryptionState = data.encryptionState ?? MessageEncryptionState.Plain;

        let content = data.content;
        /** Set when the ciphertext could not be turned into readable content on this device. */
        let undecryptable = false;

        const contextId = data.conversationId ?? data.channelId;

        // §L.9: a server field must not downgrade a context, so this is checked before the `Encrypted` branch.
        if (
            encryptionState !== MessageEncryptionState.Encrypted &&
            contextId &&
            (await this.mlsService.getEncryptionFloor(contextId)) !== null
        ) {
            this.mlsHealth.recordFailure(
                contextId,
                !!data.channelId,
                'downgraded',
                `message ${data.messageId} claims to be unencrypted in a context this device has ` +
                    `encrypted`,
            );
            undecryptable = true;
        }

        if (encryptionState === MessageEncryptionState.Encrypted && contextId) {
            const ownDeviceId = await this.mlsService.getOrCreateDeviceIdentifier();
            if (data.senderDeviceId === ownDeviceId) {
                // Our own message. The author must match too: `senderDeviceId` alone is a server-side
                // suppression primitive.
                const ownUserId = this.profileService.ownProfile()?.userId;
                if (!ownUserId || data.authorId === ownUserId) return;

                console.warn(
                    'Dropping a live message the server labelled as sent by this device but ' +
                        'attributed to another author - decrypting it instead',
                    data.messageId,
                    data.authorId,
                );
            }

            // Decrypt against the generation the message names; whichever group we hold gives silent garbage.
            const generation = data.mlsGeneration ?? (await this.mlsService.getKnownGeneration(contextId));
            let groupId =
                generation === null || generation === undefined
                    ? null
                    : await this.mlsService.getGroupId(contextId, generation);

            // Not joined yet, most likely a context we were added to while online.
            if (!groupId && this.mlsService.keyHandle()) {
                try {
                    await this.mlsSync.processPendingWelcomes();
                    groupId =
                        generation === null || generation === undefined
                            ? await this.mlsService.getActiveGroupId(contextId)
                            : await this.mlsService.getGroupId(contextId, generation);
                } catch (err) {
                    console.error('Failed to join MLS group on welcome fetch', err);
                }
            }

            const isChannel = !!data.channelId;
            let plaintext: string | null = null;

            if (groupId) {
                // Context, generation and the claimed author are part of the key: a bare `messageId` is replayable.
                plaintext = await this.mlsService.getCachedMessage(
                    contextId,
                    generation ?? null,
                    data.messageId,
                    data.authorId,
                );

                if (!plaintext) {
                    // Through the sync service so the decrypt takes the context queue and the roster check.
                    plaintext = await this.mlsSync.decryptMessage(
                        contextId,
                        isChannel,
                        groupId,
                        fromBase64(data.content),
                        data.messageId,
                        data.authorId,
                    );
                    if (plaintext) {
                        void this.mlsService.cacheMessage(
                            contextId,
                            generation ?? null,
                            data.messageId,
                            plaintext,
                            data.authorId,
                        );
                    }
                }
            } else {
                this.mlsHealth.recordFailure(contextId, isChannel, 'not-admitted');
            }

            if (plaintext) {
                content = plaintext;
            } else {
                // Never the raw wire value: base64 ciphertext in the UI reads as a working conversation.
                undecryptable = true;
            }
        }

        let body: string;
        try {
            const bytes = Uint8Array.from(atob(content), c => c.charCodeAt(0));
            body = new TextDecoder().decode(bytes);
        } catch {
            body = content;
        }
        // A notification whose body is ciphertext is worse than no notification body at all.
        if (undecryptable) body = '';

        const extra: Record<string, string> = {};
        if (data.conversationId) extra['conversationId'] = data.conversationId;
        if (data.channelId) extra['channelId'] = data.channelId;

        const createdAt = data.createdAt ? new Date(data.createdAt) : new Date();

        // Emit the message first so the UI updates immediately, regardless of notification delays.
        this.messageObservable.next({
            id: data.messageId,
            content,
            authorId: data.authorId,
            conversationId: data.conversationId,
            channelId: data.channelId,
            createdAt,
            updatedAt: createdAt,
            isPending: false,
            isFailed: false,
            attachments: data.attachments,
            inReplyTo: data.inReplyTo,
            mentions: data.mentions ?? [],
            encryptionState,
            mlsEpoch: data.mlsEpoch,
            mlsSequenceNumber: data.mlsSequenceNumber,
            senderDeviceId: data.senderDeviceId,
            type: MessageType.Message,
            embedsJson: data.embedsJson,
            flags: data.flags,
            editedAt: data.editedAt,
            undecryptable,
        });

        if (!this.markNotified(data.messageId)) return;

        const sender = await firstValueFrom(
            this.profileService.getByUserId(data.authorId).pipe(
                timeout(5_000),
                catchError(() => of(null)),
            ),
        );
        await this.notificationService.createNotification({
            title: sender?.userName ?? 'New message',
            message: body,
            profile: sender ?? undefined,
            sound: NotificationSound.NewMessage,
            actionTypeId: 'message',
            extra,
        });
    }

    /** Returns false (and skips) if this messageId was already notified; bounded so long sessions don't leak memory. */
    private markNotified(messageId: string): boolean {
        if (this.notifiedMessageIds.has(messageId)) return false;
        this.notifiedMessageIds.add(messageId);
        if (this.notifiedMessageIds.size > 200) {
            const oldest = this.notifiedMessageIds.values().next().value;
            if (oldest !== undefined) this.notifiedMessageIds.delete(oldest);
        }
        return true;
    }
}
