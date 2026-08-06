import {inject, Injectable} from '@angular/core';
import {NotificationService, NotificationSound} from "./notification.service";
import {catchError, concatMap, firstValueFrom, from, of, Subject, timeout} from "rxjs";
import {MessageDto} from "../dtos/response/message.dto";
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';
import {MessageType} from '../enums/message-type.enum';
import {AttachmentDto} from "./file.service";
import {CallStateChangedEvent} from '../dtos/response/ongoing-call.dto';
import {OnlineStatus} from '../dtos/response/profile.dto';
import {ProfileService} from "./profile.service";
import {MlsService} from './mls.service';
import {MlsSyncService} from './mls-sync.service';
import {MlsHealthService} from './mls-health.service';
import {ConversationService} from './conversation.service';
import {fromBase64} from "../helpers/base64.helper";
import {ConnectionState, RealtimeConnectionService} from "./realtime-connection.service";
import {PrivacySettingsService} from "./privacy-settings.service";

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
    /** Message bitfield - carries the suppress-embeds bit. */
    flags?: number;
    /** When the author last changed the text. Null when this update was not an author edit. */
    editedAt?: string | null;
    /**
     * False for updates the author did not cause - a preview attaching, a suppression.
     *
     * <p>This event used to skip the author entirely, on the grounds that their own client had
     * already rendered the edit. That reasoning does not hold for an update they did not make, so
     * previews and suppressions are delivered to everyone; this flag is how the two are told
     * apart.</p>
     */
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
 * A device is asking to be let into a context's MLS group (contract §B).
 *
 * <p><b>This event is a prompt, and deliberately not enough to act on.</b> It carries no key
 * package: the server fans it out to every member of the conversation, and a push is not the
 * place to hand a leaf's key material to peers who have not yet decided to admit it. A reviewer
 * has to fetch the request from `GET .../mls/join-requests`, which is also the only route that
 * gives the requester's *other* devices those bytes - and therefore the only way the §G
 * own-device ceremony could ever begin. A client that treats the push as sufficient does nothing
 * at all, which is indistinguishable from admission review not existing (§L.3).</p>
 *
 * <p>The audience includes the requester's own account, because their other devices are the only
 * party holding the account master key. The requesting device filters itself out on
 * {@link requesterDeviceId}.</p>
 */
export interface MlsJoinRequestEvent extends MlsContextEvent {
    requestId: string;
    requesterUserId: string;
    requesterDeviceId: string;
    /**
     * Whatever the requesting device calls itself, so a prompt can say "Alice's new laptop" rather
     * than a UUID. Chosen by that device, verified by nobody, and absent from the review-queue
     * read - the push is the only place it appears. Display only; nothing is authorized on it.
     */
    requesterDeviceName: string | null;
    /** The requester's long-lived identity fingerprint - the value a human compares out of band. */
    signatureKeyFingerprint: string;
    /** The server's published verdict on whether a human must tap approve (§J.4). */
    requiresManualApproval: boolean;
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

/**
 * `conversation.MlsDeviceRemoved`, which is **not** an {@link MlsCommitPushPayload} however much it
 * looks like one.
 *
 * <p>It names the device that was <i>removed</i> as `userId`/`deviceId`, where every other MLS push
 * carries the device that <i>sent</i> something as `senderDeviceId` (`DeviceRemovedHandler.cs:132`).
 * This was typed as a commit payload, which compiled and behaved because `toContextEvent` reads only
 * the context fields - but anyone reaching for the removed device got `undefined`. venta-mobile
 * suppresses its launch-time admission sweep on this event, and an Alpine copy written against
 * `senderDeviceId` would suppress nothing while appearing to work.</p>
 *
 * <p>Both ids are checked together wherever this is acted on. `deviceId` is client-chosen and unique
 * only per account, so matching it alone would let a co-member's device id stand in for one of
 * ours.</p>
 */
interface MlsDeviceRemovedPushPayload {
    contextId?: string;
    conversationId?: string | null;
    channelId?: string | null;
    generation: number;
    epoch: number;
    /** The account whose device was removed - not the actor who removed it. */
    userId: string;
    /** The removed device's client device id. */
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
    /**
     * The message's *stored* timestamp, not this device's receipt time.
     *
     * <p>Optional only so a client can outlive a server that predates it - every live server sends
     * it. Falling back to `new Date()` is what this used to do unconditionally, and the two drift
     * by however long the message spent on the broker, which is enough to sort a burst wrongly and
     * to put a visible clock skew on the bubble.</p>
     */
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
    /** Message bitfield. A message can arrive already suppressed - a restore, a backfill. */
    flags?: number;
    editedAt?: string | null;
}

/**
 * Normalizes an MLS push into "which context, and what kind of context".
 *
 * These pushes now fan out to channels as well as conversations, so the kind has to come from
 * which id the payload carries rather than from an assumption about who is listening. A client
 * that treated a channel commit as a conversation one would fetch commits from the wrong route
 * and quietly never catch up.
 */
export function toContextEvent(
    payload: { contextId?: string; conversationId?: string | null; channelId?: string | null; generation: number },
): MlsContextEvent {
    return {
        contextId: payload.contextId ?? payload.conversationId ?? payload.channelId ?? '',
        isChannel: !!payload.channelId,
        generation: payload.generation,
    };
}

/**
 * Normalizes a join-request push, and fails closed on the one field that is a policy decision.
 *
 * <p>`requiresManualApproval` absent means an older server, or a payload that lost the field on
 * the way here. Defaulting it to false would read as "this may be admitted without anyone being
 * asked", which is the permissive answer to a question about admitting a device to an encrypted
 * group - so an unstated verdict is taken as "a human decides" (§J.4).</p>
 */
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
    public messageObservable = new Subject<MessageDto>()
    public messageUpdatedObservable = new Subject<MessageUpdatedEvent>()
    public messageDeletedObservable = new Subject<MessageDeletedEvent>()
    public conversationRemovedObservable = new Subject<ConversationRemoved>()
    public conversationMemberRemovedObservable = new Subject<ConversationMemberRemoved>()
    public userTypingObservable = new Subject<UserTypingEvent>()
    public userOnlineObservable = new Subject<string>()
    public userOfflineObservable = new Subject<string>()
    public conversationCreatedObservable = new Subject<string>()
    /**
     * A call in one of our conversations started or ended.
     *
     * <p>Addressed to every member of the conversation, not just the call's roster - that is the
     * whole point of it. `call.IncomingCall` reaches invitees, and nothing at all reached someone
     * who declined, left, or was never invited, so a call happening next to them was invisible.</p>
     */
    public conversationCallStateObservable = new Subject<CallStateChangedEvent>()
    public welcomeObservable = new Subject<string>()
    /** A commit advanced a group we are in. Carries no commit bytes by design - see MlsSyncService. */
    public mlsCommitObservable = new Subject<MlsContextEvent>()
    /** Encryption was switched on or off for a context. */
    public mlsStateChangedObservable = new Subject<MlsContextEvent>()
    /** A device asked to be admitted to a context, and somebody has to review it. */
    public mlsJoinRequestObservable = new Subject<MlsJoinRequestEvent>()
    public reactionAddedObservable = new Subject<ReactionEvent>()
    public reactionRemovedObservable = new Subject<ReactionEvent>()
    public messagePinnedObservable = new Subject<MessagePinnedEvent>()
    public messageUnpinnedObservable = new Subject<MessageUnpinnedEvent>()
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

    /**
     * Announces that the user is typing.
     *
     * <p>Suppressed when the account has turned typing indicators off (T2-18). Gated here rather
     * than at each composer so every caller is covered by construction. Read state deliberately is
     * <i>not</i> gated alongside it: `UpdateLastRead` also drives the user's own unread badges, so
     * withholding it would break their client rather than anyone else's view. Keeping a read
     * receipt from other people is the server's half of that setting.</p>
     */
    invokeStartTyping(conversationId: string): void {
        if (!this.privacy.sendTypingIndicators()) return;
        void this.realtime.invoke('conversation.StartTyping', conversationId);
    }

    private setupListeners(): void {
        // Friend requests moved to the `social.*` events -see SocialWebsocketService and
        // RelationshipStore. The old conversation.FriendRequest{Accepted,Received} pair only
        // carried a username, so every listener had to refetch the whole relationship list.
        this.realtime.on('conversation.MessageUpdated', async (data: MessageUpdatedEvent) => {
            // Not logged. `MessageUpdatedEvent` carries `content`, which is the edited body -
            // plaintext in an unencrypted conversation - and this console ships in release builds.
            this.messageUpdatedObservable.next(data);
        })

        this.realtime.on('conversation.MessageDeleted', async (data: MessageDeletedEvent) => {
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

        this.realtime.on('conversation.CallStateChanged', (data: CallStateChangedEvent) => {
            this.conversationCallStateObservable.next(data);
        });

        this.realtime.on('conversation.ConversationCreated', (conversationId: string) => {
            console.log('ConversationCreated:', conversationId);
            this.conversationCreatedObservable.next(conversationId);
        });

        // Emitted for channel contexts too now, where it previously went to nobody. The context is
        // whatever `contextId` names and the kind is decided by which id came with it - a channel
        // commit must never be taken to imply conversation membership.
        this.realtime.on('conversation.MlsCommit', (payload: MlsCommitPushPayload) => {
            this.mlsCommitObservable.next(toContextEvent(payload));
        });

        // A device was removed from the account and has to be committed out of every group it holds
        // a leaf in. Nothing is applied here: this only prompts the ordered catch-up, which is what
        // discovers the removal and produces the commit for it.
        this.realtime.on('conversation.MlsDeviceRemoved', (payload: MlsDeviceRemovedPushPayload) => {
            this.mlsCommitObservable.next(toContextEvent(payload));
        });

        // A device joined a group. Interesting only as a prompt to re-read the roster - the
        // membership change itself arrives as a commit through the ordered fetch.
        this.realtime.on('conversation.MlsDeviceAdmitted', (payload: MlsCommitPushPayload) => {
            this.mlsCommitObservable.next(toContextEvent(payload));
        });

        // A device wants in. This was the one MLS push nothing listened for, and the consequence
        // was that a device excluded from a DM asked correctly, the server told every member's
        // client, and the event was dropped on the floor - so the request sat Pending until it
        // expired and the excluded device could never read the conversation. Nothing is decided
        // here: the payload carries no key package on purpose, so the review surface re-reads the
        // queue over HTTP and that read is what the decision is made against.
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

        // A message the server declares cleartext, in a context this device has encrypted. §L.9:
        // encryption state is a server field and must not be able to downgrade a context, so this
        // is rendered as untrusted rather than as the author's words. Checked before the
        // `Encrypted` branch so a downgrade cannot route around it.
        if (encryptionState !== MessageEncryptionState.Encrypted && contextId
            && await this.mlsService.getEncryptionFloor(contextId) !== null) {
            this.mlsHealth.recordFailure(
                contextId, !!data.channelId, 'downgraded',
                `message ${data.messageId} claims to be unencrypted in a context this device has `
                + `encrypted`);
            undecryptable = true;
        }

        if (encryptionState === MessageEncryptionState.Encrypted && contextId) {
            const ownDeviceId = await this.mlsService.getOrCreateDeviceIdentifier();
            if (data.senderDeviceId === ownDeviceId) {
                // Our own message: the plaintext is already in the store from the send flow, and
                // our own ciphertext cannot be decrypted by us anyway.
                //
                // `senderDeviceId` is a server field, which makes an unconditional drop here a
                // suppression primitive - the server could hide *any* message from the live view by
                // labelling it as ours. Narrowed by also requiring the claimed author to be us, so
                // the most the label can now suppress is a message the server is simultaneously
                // attributing to this account. Anything else is logged and decrypted, where the MLS
                // credential decides. Not a cryptographic check, and not claimed as one - but the
                // difference between "hide anyone" and "hide something it says you wrote" is the
                // difference between silent censorship and a visible lie.
                const ownUserId = this.profileService.ownProfile()?.userId;
                if (!ownUserId || data.authorId === ownUserId) return;

                console.warn(
                    'Dropping a live message the server labelled as sent by this device but '
                    + 'attributed to another author - decrypting it instead',
                    data.messageId, data.authorId);
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

            const isChannel = !!data.channelId;
            let plaintext: string | null = null;

            if (groupId) {
                // Context and generation are part of the key, and the claimed author is re-checked
                // against the one recorded at decrypt time. On the bare, server-chosen `messageId`
                // this returned another conversation's plaintext for a replayed id, with no
                // decryption and therefore no author binding at all.
                plaintext = await this.mlsService.getCachedMessage(
                    contextId, generation ?? null, data.messageId, data.authorId);

                if (!plaintext) {
                    // Through the sync service so the decrypt takes the context queue: issued
                    // straight from here it could interleave between the stage and the merge of a
                    // two-phase commit. It also applies the roster check, which had no call sites
                    // at all before this.
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
                            contextId, generation ?? null, data.messageId, plaintext, data.authorId);
                    }
                }
            } else {
                this.mlsHealth.recordFailure(contextId, isChannel, 'not-admitted');
            }

            if (plaintext) {
                content = plaintext;
            } else {
                // Never the raw wire value. Handing base64 ciphertext to the UI as if it were a
                // message is how an unreadable conversation looked like a working one - the user
                // saw gibberish and nothing anywhere said this device could not read the context.
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
