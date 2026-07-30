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
    userId: string;
    channelId?: string;
    conversationId?: string;
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
    public reactionAddedObservable = new Subject<ReactionEvent>()
    public reactionRemovedObservable = new Subject<ReactionEvent>()
    public friendRequestReceivedObservable = new Subject<void>()
    public friendRequestAcceptedObservable = new Subject<void>()
    private realtime = inject(RealtimeConnectionService);
    private notificationService = inject(NotificationService);
    private profileService = inject(ProfileService);
    private mlsService = inject(MlsService);
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
        this.realtime.on('conversation.FriendRequestAccepted', async (data: { acceptantUserName: string }) => {
            console.log('Friend request accepted:', data);
            this.friendRequestAcceptedObservable.next();
            await this.notificationService.createNotification({
                title: 'Friend request accepted',
                message: `${data.acceptantUserName} accepted your friend request`,
                sound: NotificationSound.NewMessage,
            });
        })

        // NOTE: not listed in the migration guide; assuming the same conversation.* prefix.
        this.realtime.on('conversation.FriendRequestReceived', async (data: { senderUserName: string }) => {
            console.log('Friend request received:', data);
            this.friendRequestReceivedObservable.next();
            await this.notificationService.createNotification({
                title: 'Friend request',
                message: `${data.senderUserName} sent you a friend request`,
                sound: NotificationSound.NewMessage,
            });
        })

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
    }

    private async handleMessageCreated(data: MessageCreatedPayload): Promise<void> {
        const encryptionState = data.encryptionState ?? MessageEncryptionState.Plain;

        console.log('incomming msg', data)
        let content = data.content;

        if (encryptionState === MessageEncryptionState.Encrypted && data.conversationId) {
            const ownDeviceId = await this.mlsService.getOrCreateDeviceIdentifier();
            if (data.senderDeviceId === ownDeviceId) {
                // Our own message -plaintext already in store from send flow, skip WS upsert.
                return;
            }
            let groupId = await this.mlsService.getGroupIdForConversation(data.conversationId);

            // Group not registered yet -may be a new encrypted conversation created while we were
            // online. Fetch pending welcomes and try to join before decrypting.
            if (!groupId) {
                console.log('group id not found')
                const keyHandle = this.mlsService.keyHandle();
                if (keyHandle) {
                    try {
                        const welcomes = await firstValueFrom(this.conversationService.getPendingWelcomes());
                        const match = welcomes.find(w => w.conversationId === data.conversationId);
                        if (match) {
                            const info = await firstValueFrom(this.mlsService.joinGroup(match.welcome, keyHandle));
                            await this.mlsService.registerGroupForConversation(match.conversationId, info.groupId);
                            groupId = info.groupId;
                        }
                    } catch (err) {
                        console.error('Failed to join MLS group on welcome fetch', err);
                    }
                }
            }

            if (groupId) {
                console.log('group id found')
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
