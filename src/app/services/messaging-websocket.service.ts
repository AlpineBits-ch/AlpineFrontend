import {inject, Injectable} from '@angular/core';
import {NotificationService, NotificationSound} from "./notification.service";
import {catchError, concatMap, firstValueFrom, from, of, Subject, timeout} from "rxjs";
import {MessageDto} from "../dtos/response/message.dto";
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';
import {MessageType} from '../enums/message-type.enum';
import {AttachmentDto} from "./file.service";
import {OnlineStatus} from '../dtos/response/profile.dto';
import {ProfileService} from "./profile.service";
import {MlsService} from './mls.service';
import {MlsSyncService} from './mls-sync.service';
import {ConversationService} from './conversation.service';
import {fromBase64} from "../helpers/base64.helper";
import {ConnectionState, RealtimeConnectionService} from "./realtime-connection.service";

// Re-exported for existing importers (connection-status, guild-websocket, …).
export {ConnectionState};

export interface MessageUpdatedEvent {
    messageId: string;
    content: string;
    authorId: string;
    conversationId: string | undefined;
    channelId: string | undefined;
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

/**
 * The server sends a nudge, not the commit. Group state advances only via the ordered fetch in
 * MlsSyncService - applying commits in push-arrival order forks the client permanently.
 */
interface MlsCommitPushPayload {
    contextId?: string;
    conversationId?: string | null;
    channelId?: string | null;
    generation: number;
    epoch: number;
    senderDeviceId: string;
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
}

@Injectable({
    providedIn: 'root',
})
export class MessagingWebsocketService {
    public messageObservable = new Subject<MessageDto>()
    public messageUpdatedObservable = new Subject<MessageUpdatedEvent>()
    public messageDeletedObservable = new Subject<MessageDeletedEvent>()
    public conversationRemovedObservable = new Subject<ConversationRemoved>()
    public conversationMemberRemovedObservable = new Subject<ConversationMemberRemoved>()
    public userTypingObservable = new Subject<UserTypingEvent>()
    public userOnlineObservable = new Subject<string>()
    public userOfflineObservable = new Subject<string>()
    public conversationCreatedObservable = new Subject<string>()
    public welcomeObservable = new Subject<string>()
    /** A commit advanced a group we are in. Carries no commit bytes by design - see MlsSyncService. */
    public mlsCommitObservable = new Subject<MlsContextEvent>()
    /** Encryption was switched on or off for a context. */
    public mlsStateChangedObservable = new Subject<MlsContextEvent>()
    public reactionAddedObservable = new Subject<ReactionEvent>()
    public reactionRemovedObservable = new Subject<ReactionEvent>()
    public messagePinnedObservable = new Subject<MessagePinnedEvent>()
    public messageUnpinnedObservable = new Subject<MessageUnpinnedEvent>()
    private realtime = inject(RealtimeConnectionService);
    private notificationService = inject(NotificationService);
    private profileService = inject(ProfileService);
    private mlsService = inject(MlsService);
    private mlsSync = inject(MlsSyncService);
    private conversationService = inject(ConversationService);
    private readonly _rawMessageCreated$ = new Subject<MessageCreatedPayload>();
    private listenersSetUp = false;
    // SignalR's automatic reconnect can redeliver 'conversation.MessageCreated' for a message
    // that already arrived just before the drop, which used to fire the notification sound twice.
    private readonly notifiedMessageIds = new Set<string>();

    constructor() {
        this._rawMessageCreated$.pipe(
            concatMap(data => from(this.handleMessageCreated(data))),
        ).subscribe();
    }

    /** Shared connection state -one connection now backs every feature. */
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

    invokeStartTyping(conversationId: string): void {
        void this.realtime.invoke('conversation.StartTyping', conversationId);
    }

    private setupListeners(): void {
        // Friend requests moved to the `social.*` events -see SocialWebsocketService and
        // RelationshipStore. The old conversation.FriendRequest{Accepted,Received} pair only
        // carried a username, so every listener had to refetch the whole relationship list.
        this.realtime.on('conversation.MessageUpdated', async (data: MessageUpdatedEvent) => {
            console.log('Message updated:', data);
            this.messageUpdatedObservable.next(data);
        })

        this.realtime.on('conversation.MessageDeleted', async (data: MessageDeletedEvent) => {
            console.log('Message deleted:', data);
            this.messageDeletedObservable.next(data);
        })

        this.realtime.on('conversation.ConversationDeleted', async (data: ConversationRemoved) => {
            console.log('Conversation removed:', data);
            this.conversationRemovedObservable.next(data);
        })
        this.realtime.on('conversation.MemberLeft', async (data: ConversationMemberRemoved) => {
            console.log('Conversation member removed:', data);
            this.conversationMemberRemovedObservable.next(data);
        })

        this.realtime.on('conversation.UserTyping', (data: UserTypingEvent) => {
            this.userTypingObservable.next(data);
        })

        this.realtime.on('presence.UserOnline', async (str: string) => {
            this.userOnlineObservable.next(str);
            this.profileService.setOnlineStatus(str, OnlineStatus.Online);
        })

        this.realtime.on('presence.UserOffline', async (str: string) => {
            this.userOfflineObservable.next(str);
            this.profileService.setOnlineStatus(str, OnlineStatus.Offline);
        })


        this.realtime.on('conversation.MessageCreated', (data: MessageCreatedPayload) => {
            this._rawMessageCreated$.next(data);
        });

        this.realtime.on('conversation.ConversationCreated', (conversationId: string) => {
            console.log('ConversationCreated:', conversationId);
            this.conversationCreatedObservable.next(conversationId);
        });

        this.realtime.on('conversation.MlsCommit', (payload: MlsCommitPushPayload) => {
            this.mlsCommitObservable.next({
                contextId: payload.contextId ?? payload.conversationId ?? payload.channelId ?? '',
                isChannel: !!payload.channelId,
                generation: payload.generation,
            });
        });

        this.realtime.on('conversation.MlsStateChanged', (payload: MlsStateChangedPushPayload) => {
            this.mlsStateChangedObservable.next({
                contextId: payload.contextId ?? payload.conversationId ?? payload.channelId ?? '',
                isChannel: !!payload.channelId,
                generation: payload.generation,
            });
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

        console.log('incomming msg', data)
        let content = data.content;

        const contextId = data.conversationId ?? data.channelId;

        if (encryptionState === MessageEncryptionState.Encrypted && contextId) {
            const ownDeviceId = await this.mlsService.getOrCreateDeviceIdentifier();
            if (data.senderDeviceId === ownDeviceId) {
                // Our own message -plaintext already in store from send flow, skip WS upsert.
                return;
            }

            // The message names the generation it was sealed under. Using whichever group we
            // happen to hold would decrypt against the wrong keys the moment a context has been
            // toggled off and on, which is silent garbage rather than a clean failure.
            const generation = data.mlsGeneration ?? await this.mlsService.getKnownGeneration(contextId);
            let groupId = generation === null || generation === undefined
                ? null
                : await this.mlsService.getGroupId(contextId, generation);

            // Not joined yet - most likely a context we were added to while online. The Welcome may
            // already be waiting for this device.
            if (!groupId && this.mlsService.keyHandle()) {
                try {
                    await this.mlsSync.processPendingWelcomes();
                    groupId = generation === null || generation === undefined
                        ? await this.mlsService.getActiveGroupId(contextId)
                        : await this.mlsService.getGroupId(contextId, generation);
                } catch (err) {
                    console.error('Failed to join MLS group on welcome fetch', err);
                }
            }

            if (groupId) {
                const cached = await this.mlsService.getCachedMessage(data.messageId);
                if (cached) {
                    content = cached;
                } else {
                    try {
                        const processed = await firstValueFrom(this.mlsService.processMessage(groupId, fromBase64(data.content)));
                        if (processed.kind === 'application' && processed.plaintext) {
                            content = processed.plaintext;
                            console.log('received: ' + processed.plaintext)
                            void this.mlsService.cacheMessage(data.messageId, processed.plaintext);
                        }
                    } catch (err) {
                        console.error('Failed to decrypt incoming MLS message', err);
                    }
                }
            }
        }

        let body: string;
        try {
            const bytes = Uint8Array.from(atob(content), c => c.charCodeAt(0));
            body = new TextDecoder().decode(bytes);
        } catch {
            body = content;
        }

        const extra: Record<string, string> = {};
        if (data.conversationId) extra['conversationId'] = data.conversationId;
        if (data.channelId) extra['channelId'] = data.channelId;

        // Emit the message first so the UI updates immediately, regardless of notification delays.
        this.messageObservable.next({
            id: data.messageId,
            content,
            authorId: data.authorId,
            conversationId: data.conversationId,
            channelId: data.channelId,
            createdAt: new Date(),
            updatedAt: new Date(),
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
        });

        if (!this.markNotified(data.messageId)) return;

        const sender = await firstValueFrom(
            this.profileService.getByUserId(data.authorId).pipe(
                timeout(5_000),
                catchError(() => of(null)),
            )
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

    /** Returns false (and skips) if this messageId was already notified -bounded so long sessions don't leak memory. */
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
