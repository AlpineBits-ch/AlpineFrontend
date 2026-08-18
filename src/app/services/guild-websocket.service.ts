import {inject, Injectable} from '@angular/core';
import {RealtimeConnectionService} from './realtime-connection.service';
import {ShareViewersDto} from '../dtos/response/share-viewers.dto';
import {
    MessagePinnedEvent,
    MessageUnpinnedEvent,
    MessageUpdatedEvent,
    MlsJoinRequestEvent,
    ReactionEvent,
} from './messaging-websocket.service';
import {MlsService} from './mls.service';
import {MlsHealthService} from './mls-health.service';
import {decodeBody} from '../helpers/message-content.helper';
import {toBase64} from '../helpers/base64.helper';
import {NotificationService, NotificationSound} from './notification.service';
import {catchError, firstValueFrom, of, Subject, timeout} from 'rxjs';
import {MessageDto, MessageEmbed} from '../dtos/response/message.dto';
import {GuildDto} from '../dtos/response/guild.dto';
import {PersonaApprovalState} from '../dtos/response/persona.dto';
import {SceneTurnChangedDto, SceneTurnNudgeDto, SceneUpdatedDto} from '../dtos/response/scene.dto';
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';
import {MessageType} from '../enums/message-type.enum';
import {AttachmentDto} from './file.service';
import {ReorderChannesDto} from '../dtos/request/reorder-channel.dto';
import {ReorderRolesDto} from '../dtos/request/reorder-roles.dto';
import {ProfileService} from './profile.service';
import {OnlineStatus} from '../dtos/response/profile.dto';
import {ForumConfig, ForumTag} from '../dtos/response/forum.dto';
import {PrivacySettingsService} from './privacy-settings.service';
import {UserActivityService} from './user-activity.service';
import {Activity} from '../models/activity.model';
import {
    VoiceEventEnvelope,
    VoiceHeartbeatState,
    VoiceResyncEvent,
    VoiceRoomSnapshot,
} from '../models/voice-room';
import {WsVoiceRing, WsVoiceRingDismissed, WsVoiceRingResolved} from '../dtos/response/voice-ring.dto';

export interface ChannelTypingEvent {
    channelId: string;
    userId: string;
}

// ── Guild voice events (server → client) ─────────────────────────────────────
//
// Every one of these extends VoiceEventEnvelope: the server's announcer stamps `instanceId` and
// `version` onto each payload, so a client holding v7 that receives v9 knows it missed one. See
// VoiceRoomTracker for what to do about it. The fields are optional on the interfaces because the
// guild presence fan-out below has not migrated to the announcer yet.

export interface WsUserJoinedVoice extends VoiceEventEnvelope {
    userId: string;
    channelId: string;
    guildId: string;
}

export interface WsUserLeftVoice extends VoiceEventEnvelope {
    userId: string;
    channelId: string;
    guildId: string;
}

export interface WsGuildParticipantJoined extends VoiceEventEnvelope {
    userId: string;
    mediaSessionId: string;
    audioTrackName: string;
    channelId: string;
}

export interface WsGuildTrackPublished extends VoiceEventEnvelope {
    userId: string;
    mediaSessionId: string;
    trackName: string;
    kind: 'video' | 'screen' | 'screenAudio';
    shareId?: string;
    channelId: string;
}

export interface WsGuildTrackClosed extends VoiceEventEnvelope {
    userId: string;
    trackName: string;
    channelId: string;
}

export interface WsVoiceMuteChanged extends VoiceEventEnvelope {
    userId: string;
    isMuted: boolean;
    channelId: string;
    serverForced: boolean;
}

export interface WsVoiceDeafenChanged extends VoiceEventEnvelope {
    userId: string;
    isDeafened: boolean;
    channelId: string;
    serverForced: boolean;
}

export interface WsVoiceCameraChanged extends VoiceEventEnvelope {
    userId: string;
    isCameraOn: boolean;
    channelId: string;
}

export interface WsVoiceScreenShareStarted extends VoiceEventEnvelope {
    userId: string;
    shareId: string;
    trackName: string;
    channelId: string;
}

export interface WsVoiceScreenShareStopped extends VoiceEventEnvelope {
    shareId: string;
    channelId: string;
}

/** {@link VoiceResyncEvent} for a guild channel. */
export interface WsGuildVoiceResync extends VoiceResyncEvent {
    channelId: string;
}

/** We joined this voice channel from another device, so this one was removed from it. */
export interface WsKickedByOtherDevice {
    channelId: string;
    guildId: string;
}

export interface WsMovedToChannel {
    channelId: string;
    guildId: string;
    movedBy: string;
}

export interface WsChannelCreated {
    channelId: string;
    guildId: string;
}

export interface WsChannelDeleted {
    channelId: string;
    guildId: string;
}

/**
 * A channel's encryption was toggled. Clients must act on this: one that keeps encrypting after a
 * disable, or keeps sending plaintext after an enable, has its sends refused until it catches up.
 */
export interface WsChannelMlsStateChanged {
    channelId: string;
    guildId: string;
    encrypted: boolean;
    /** The generation now active, or the one just terminated. */
    generation: number;
    changedByUserId: string;
}

/**
 * A device is asking to be let into a *channel's* MLS group - the channel-side twin of
 * `conversation.MlsJoinRequest`.
 *
 * <p><b>Thinner than its twin, and deliberately so.</b> The conversation push at least names the
 * request, the requesting device and the fingerprint a human is supposed to compare; this one
 * carries three ids and nothing else. Neither is enough to act on - no key package is fanned out to
 * peers who have not decided to admit the leaf yet - so the review surface re-reads
 * `GET .../channels/{id}/mls/join-requests` either way, and that read is what the decision is made
 * against. The only thing this event has to get right is *that* something is waiting, and for which
 * channel.</p>
 *
 * <p>Every field the twin carries is declared optional rather than omitted: a server that starts
 * sending them should be believed rather than ignored, and a normalizer that cannot represent them
 * would silently discard the fingerprint the moment it arrives.</p>
 */
export interface WsChannelMlsJoinRequested {
    channelId: string;
    guildId: string;
    requesterUserId: string;
    requestId?: string;
    requesterDeviceId?: string;
    requesterDeviceName?: string | null;
    signatureKeyFingerprint?: string;
    generation?: number;
    /** The server's published verdict on whether a human must tap approve (§J.4). */
    requiresManualApproval?: boolean;
}

/**
 * Normalizes a channel join-request push, failing closed on the one field that is a policy call.
 *
 * <p>Mirrors `toJoinRequestEvent`: `requiresManualApproval` absent means an older server, or a
 * payload that lost the field on the way here, and defaulting it to false would read as "this may
 * be admitted without anyone being asked" - the permissive answer to a question about admitting a
 * device to an encrypted group. An unstated verdict is taken as "a human decides" (§J.4). For this
 * event the field is absent from the published contract entirely, so the default *is* the answer
 * until a server starts sending one.</p>
 *
 * <p>The fields the channel push does not carry become empty rather than fabricated. They are
 * display-and-correlation only - the review surface reads the queue over HTTP for everything it
 * decides on - so an empty fingerprint here can never be mistaken for a fingerprint that matched.</p>
 */
export function toChannelJoinRequestEvent(payload: WsChannelMlsJoinRequested): MlsJoinRequestEvent {
    return {
        contextId: payload.channelId,
        isChannel: true,
        generation: payload.generation ?? 0,
        requestId: payload.requestId ?? '',
        requesterUserId: payload.requesterUserId,
        requesterDeviceId: payload.requesterDeviceId ?? '',
        requesterDeviceName: payload.requesterDeviceName ?? null,
        signatureKeyFingerprint: payload.signatureKeyFingerprint ?? '',
        requiresManualApproval: payload.requiresManualApproval ?? true,
    };
}

export interface WsCategoryCreated {
    categoryId: string;
    guildId: string;
}

/**
 * A category was renamed or moved. The payload names it and nothing more, so the current row has
 * to be re-read - the same shape `guild.ChannelUpdated` has, and for the same reason.
 */
export interface WsCategoryUpdated {
    categoryId: string;
    guildId: string;
}

export interface WsCategoryDeleted {
    categoryId: string;
    guildId: string;
}

export interface WsWikiPageCreated {
    pageId: string;
    guildId: string;
}

export interface WsWikiPageUpdated {
    pageId: string;
    guildId: string;
}

export interface WsWikiPageDeleted {
    pageId: string;
    guildId: string;
}

export interface WsWikiCategoryCreated {
    categoryId: string;
    guildId: string;
}

export interface WsWikiCategoryUpdated {
    categoryId: string;
    guildId: string;
}

export interface WsWikiCategoryDeleted {
    categoryId: string;
    guildId: string;
}

export interface WsPersonaProfileChanged {
    guildId: string;
    personaId: string;
    approvalState: PersonaApprovalState;
    /** The profile's own state, broadcast guild-wide. Grants are not in it; only the GET resolves those. */
    canSpeak: boolean;
}

/** Guildless when the account-level row changed, so every guild the character is in must re-read. */
export interface WsPersonaUpdated {
    guildId?: string;
    personaId: string;
    name: string;
    avatarUrl?: string | null;
}

/** The nudge, and the escalation to whoever holds `ManageScenes` after a second miss. */
export type WsSceneTurnNudge = SceneTurnNudgeDto;

/** The turn moved. A patch: the clock and whose turn it is, not the whole scene. */
export type WsSceneTurnChanged = SceneTurnChangedDto;

/** Status, cast or rotation moved. Carries no display data for the cast. */
export type WsSceneUpdated = SceneUpdatedDto;

export interface WsMemberBanned {
    guildId: string;
    userId: string;
    reason?: string;
}

export interface WsMemberKicked {
    guildId: string;
    userId: string;
}

/**
 * `guild.MemberMovedOut` - a flatmate was moved out of a household.
 *
 * <p>Removal, and the only kind a household has: with the Moderation module off there is no kick to
 * fire `guild.MemberKicked` instead. Same envelope, deliberately kept as its own event so a member
 * list can say "moved out" rather than "was kicked".</p>
 */
export interface WsMemberMovedOut {
    guildId: string;
    userId: string;
}

export interface WsMemberMuted {
    guildId: string;
    userId: string;
    mutedUntil: string;
}

export interface WsMemberUnmuted {
    guildId: string;
    userId: string;
}

export interface WsMemberLeft {
    guildId: string;
    userId: string;
}

export interface WsMemberJoined {
    guildId: string;
    userId: string;
}

/**
 * A member's roles or nickname changed.
 *
 * <p>`nickname` is the only field the payload carries beyond the ids, and role changes come through
 * here with it unchanged - so the event names *who* changed, never *what*. Anything computed from
 * roles (every permission gate in the UI) has to re-read the member row rather than patch it, and
 * for the signed-in user that means re-reading `GET /guilds/{id}/me`: a demotion that leaves the
 * manage controls on screen is a button that fails on press, and a promotion that does not appear
 * is a permission the user has and cannot use.</p>
 */
export interface WsMemberUpdated {
    guildId: string;
    userId: string;
    nickname: string | null;
}

export interface WsGuildDeleted {
    guildId: string;
}

export interface WsGuildUpdated {
    guildId: string;
}

export interface WsChannelUpdated {
    channelId: string;
    guildId: string;
}

export interface WsThreadCreated {
    channelId: string;
    parentChannelId: string;
    guildId: string;
    /** Forum posts only; absent for text-channel threads. */
    tagIds?: string[];
}

/**
 * Applied-tag changes, pins, locks, renames and archives all arrive here rather
 * than as separate events. The payload carries the full current state of those
 * flags, so treat it as a replace, not a patch.
 */
export interface WsThreadUpdated {
    channelId: string;
    parentChannelId: string;
    guildId: string;
    name?: string;
    tagIds?: string[];
    isPinned?: boolean;
    isLocked?: boolean;
    isArchived?: boolean;
}

export interface WsForumTagEvent {
    guildId: string;
    channelId: string;
    tag: ForumTag;
}

export interface WsForumTagDeleted {
    guildId: string;
    channelId: string;
    tagId: string;
}

export interface WsForumTagsReordered {
    guildId: string;
    channelId: string;
    /** The full ordered list, not a delta. */
    tagIds: string[];
}

export interface WsForumConfigUpdated {
    guildId: string;
    channelId: string;
    config: ForumConfig;
}

export interface WsEmojiCreated {
    guildId: string;
    emojiId: string;
    name: string;
    animated: boolean;
}

export interface WsEmojiDeleted {
    guildId: string;
    emojiId: string;
}

export interface WsPresenceChanged {
    userId: string;
    guildId: string;
    status: OnlineStatus;
    /**
     * The subject's rich presence, already projected for this viewer.
     *
     * <p>Optional because it is additive - an older server simply omits it. Note that absent and
     * empty mean different things here: `[]` is how the server says a game ended, while `undefined`
     * is a server that has nothing to say on the subject, and only the first should clear anything.
     * {@link UserActivityService.set} draws that line.</p>
     */
    activities?: Activity[];
}

export interface WsBotInstalled {
    guildId: string;
    userId: string; // the bot's user id
}

export interface WsBotUninstalled {
    guildId: string;
    userId: string;
}

export interface WsEventCreated {
    guildId: string;
    eventId: string;
    title: string;
    startsAt: string;
}

export type WsEventUpdated = WsEventCreated;

export interface WsEventCancelled {
    guildId: string;
    eventId: string;
}

export interface GuildMessageCreatedPayload {
    messageId: string;
    /**
     * The message's *stored* timestamp, not this device's receipt time.
     *
     * <p>Optional only so a client can outlive a server that predates it - every live server sends
     * it. Falling back to `new Date()` is what this used to do unconditionally, and the two drift
     * by however long the message spent on the broker.</p>
     */
    createdAt?: string;
    content: string;
    authorId: string;
    conversationId: string | undefined;
    channelId: string;
    attachments: AttachmentDto[];
    inReplyTo: string | undefined;
    mentions: string[] | undefined;
    embedsJson: string | undefined;
    /** Message bitfield. A message can arrive already suppressed - a restored edit, a backfill. */
    flags?: number;
    editedAt?: string | null;
    type: string;
    systemMessageVariant: number | undefined;
}

/**
 * A message body as it comes off the guild socket.
 *
 * <p>Server-side it is a `byte[]`. System.Text.Json writes those as base64 and that is what every
 * live server sends, but the generated contract describes the field as an array of integers -
 * which is what a host with a different serializer would produce. Both are accepted rather than
 * betting on one, because everything downstream (the store, the bubble, the sidebar preview, the
 * notification body) base64-decodes the body unconditionally: a raw byte array reaching the UI
 * renders as `[104,105]`, and `decodeBody`'s tolerant fallback would hand that straight through as
 * if it were the author's words.</p>
 */
export type WireMessageContent = string | number[];

/** Normalizes {@link WireMessageContent} to the base64 every reader downstream expects. */
export function normalizeWireContent(content: WireMessageContent | null | undefined): string {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    // Chunked rather than `String.fromCharCode(...bytes)`: spreading a long body overflows the
    // argument limit and throws, which for an edit would blank a message that arrived fine.
    let binary = '';
    for (const byte of content) binary += String.fromCharCode(byte & 0xff);
    return btoa(binary);
}

/**
 * `guild.MessageUpdated` - a channel message was edited.
 *
 * <p>Nothing listened for this at all, so channel edits only appeared after a reload while the DM
 * path had been live from the start. The two are the same event with different ids on it.</p>
 */
export interface GuildMessageUpdatedPayload {
    messageId: string;
    channelId: string;
    authorId: string;
    content: WireMessageContent;
    embedsJson?: string | null;
    flags?: number;
    editedAt?: string | null;
    isAuthorEdit?: boolean;
}

/**
 * Maps a channel edit onto the same event a conversation edit produces.
 *
 * <p>Shared shape on purpose: `MessageStore.applyRemoteUpdate` already decides encrypted from
 * plaintext by looking at the *stored* message rather than the event, so a channel edit routed
 * through it gets the identical treatment - decrypted against the generation the message was
 * sealed under, and marked `undecryptable` rather than rendered when that fails. A second,
 * channel-shaped update path would have been a second place for that rule to be forgotten.</p>
 */
export function mapGuildMessageUpdatedPayload(data: GuildMessageUpdatedPayload): MessageUpdatedEvent {
    return {
        messageId: data.messageId,
        content: normalizeWireContent(data.content),
        authorId: data.authorId,
        conversationId: undefined,
        channelId: data.channelId,
        embedsJson: data.embedsJson,
        flags: data.flags,
        editedAt: data.editedAt,
        isAuthorEdit: data.isAuthorEdit,
    };
}

/** Moderation deleted a run of messages in one action. */
export interface WsMessagesBulkDeleted {
    guildId: string;
    channelId: string;
    /** Every id removed, as one list - see the store's handler for why that matters. */
    messageIds: string[];
    actorUserId: string;
}

/** Discord's component type tags, as `ComponentPayload.Type` carries them. */
export const BotComponentType = {
    ActionRow: 1,
    Button: 2,
    StringSelect: 3,
    TextInput: 4,
    UserSelect: 5,
    RoleSelect: 6,
    MentionableSelect: 7,
    ChannelSelect: 8,
} as const;

/**
 * One node of a bot-authored component tree, in Discord's own wire shape.
 *
 * <p><b>The snake_case names are deliberate, and the published contract disagrees with them.</b>
 * The AsyncAPI generator drops every member carrying a `[JsonIgnore]` attribute - on the server's
 * `ComponentPayload` that is all of them but `Type`, since the rest are `WhenWritingNull` - and
 * renders whatever survives through a camelCase policy, ignoring `[JsonPropertyName]`. So the
 * contract advertises `{type}` alone while the socket actually delivers `custom_id`, `min_length`
 * and `max_length`. Reading `customId` off one of these finds `undefined` every single time.</p>
 *
 * <p>Deliberately one type for both directions rather than an inbound and an outbound copy: the
 * modal-submit endpoint deserializes the rows the client posts back with the same `ComponentPayload`
 * class that produced them, so a divergence between the two would be a bug by construction.</p>
 */
export interface BotComponentPayload {
    /** One of {@link BotComponentType}. */
    type: number;
    /** Set only on an action row, which is the sole container type. */
    components?: BotComponentPayload[] | null;
    /** The bot's own handle for this component, echoed back verbatim when the user answers. */
    custom_id?: string | null;
    label?: string | null;
    /** Button style 1-5; on a text input, 1 is single-line and 2 is a paragraph box. */
    style?: number | null;
    url?: string | null;
    disabled?: boolean | null;
    placeholder?: string | null;
    min_values?: number | null;
    max_values?: number | null;
    // ── Text input (modals only) ──────────────────────────────────────────────
    value?: string | null;
    required?: boolean | null;
    min_length?: number | null;
    max_length?: number | null;
}

/**
 * `guild.EphemeralMessageCreated` - a bot reply only this user gets, and which the server never
 * stored. It exists exactly as long as the tab does.
 */
export interface GuildEphemeralMessagePayload {
    id: string;
    guildId?: string | null;
    channelId: string;
    /** Plain text here, unlike every other message body on this socket - see the mapper. */
    content: string;
    embeds?: MessageEmbed[];
    components?: BotComponentPayload[];
    authorId: string;
    createdAt: string;
}

/**
 * Turns an ephemeral push into something the channel can render.
 *
 * <p><b>The body is re-encoded, not passed through.</b> This is the one message event whose
 * `content` is already text - every other one carries a `byte[]` - and the message bubble decodes
 * unconditionally with `atob`. A plain sentence that happens to be valid base64 ("test" is) would
 * therefore be rendered as mojibake, and one that is not would survive only by the tolerant
 * fallback. Encoding here puts it on the same footing as every other body in the store.</p>
 *
 * <p>`isEphemeral` is what keeps it out of history: the store is in-memory either way, but the flag
 * is what stops the UI offering edit, delete and pin on something with no server-side row to act
 * on, and what tells the reader that nobody else in the channel can see it.</p>
 */
export function mapGuildEphemeralMessagePayload(data: GuildEphemeralMessagePayload): MessageDto {
    const createdAt = data.createdAt ? new Date(data.createdAt) : new Date();
    const embeds = data.embeds ?? [];
    return {
        id: data.id,
        content: toBase64(data.content ?? ''),
        authorId: data.authorId,
        conversationId: undefined,
        channelId: data.channelId,
        createdAt,
        updatedAt: createdAt,
        isPending: false,
        isFailed: false,
        isEphemeral: true,
        attachments: [],
        inReplyTo: undefined,
        mentions: [],
        encryptionState: MessageEncryptionState.Plain,
        mlsEpoch: undefined,
        mlsSequenceNumber: undefined,
        senderDeviceId: undefined,
        type: MessageType.Message,
        embedsJson: embeds.length > 0 ? JSON.stringify(embeds) : undefined,
    };
}

/**
 * `guild.ModalOpen` - a bot asking this client to put a form on screen.
 *
 * <p>`customId` is the bot's correlation handle for the answer, and goes straight back out on
 * `POST /bots/guilds/{g}/channels/{c}/modal-submit` - see
 * {@link import('./bot-command.service').BotCommandService.submitModal}. `guildId` is nullable in
 * the contract but the submit route needs it in the path, so a modal that arrives without one
 * cannot be answered.</p>
 */
export interface WsBotModalOpen {
    guildId: string | null;
    channelId: string;
    botUserId: string;
    customId: string | null;
    title: string | null;
    components: BotComponentPayload[];
}

export function mapGuildMessageCreatedPayload(data: GuildMessageCreatedPayload): MessageDto {
    const createdAt = data.createdAt ? new Date(data.createdAt) : new Date();
    return {
        id: data.messageId,
        content: data.content,
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
        encryptionState: MessageEncryptionState.Plain,
        mlsEpoch: undefined,
        mlsSequenceNumber: undefined,
        senderDeviceId: undefined,
        type: data.type as MessageType,
        embedsJson: data.embedsJson,
        flags: data.flags,
        editedAt: data.editedAt,
        systemMessageVariant: data.systemMessageVariant,
    };
}

@Injectable({
    providedIn: 'root',
})
export class GuildWebsocketService {
    public messageObservable = new Subject<MessageDto>();
    public channelReorderedObservable = new Subject<ReorderChannesDto>();
    public userTypingObservable = new Subject<ChannelTypingEvent>();
    // ── Voice observables ───────────────────────────────────────────────────────
    public userJoinedVoiceObservable = new Subject<WsUserJoinedVoice>();
    public userLeftVoiceObservable = new Subject<WsUserLeftVoice>();
    /** The audience of one screen share changed. Sent to everyone in the channel. */
    public shareViewersChangedObservable = new Subject<ShareViewersDto>();
    public guildParticipantJoinedObservable = new Subject<WsGuildParticipantJoined>();
    public guildTrackPublishedObservable = new Subject<WsGuildTrackPublished>();
    public guildTrackClosedObservable = new Subject<WsGuildTrackClosed>();
    public voiceMuteChangedObservable = new Subject<WsVoiceMuteChanged>();
    public voiceDeafenChangedObservable = new Subject<WsVoiceDeafenChanged>();
    public voiceCameraChangedObservable = new Subject<WsVoiceCameraChanged>();
    public voiceScreenShareStartedObservable = new Subject<WsVoiceScreenShareStarted>();
    public voiceScreenShareStoppedObservable = new Subject<WsVoiceScreenShareStopped>();
    public movedToChannelObservable = new Subject<WsMovedToChannel>();
    public kickedByOtherDeviceObservable = new Subject<WsKickedByOtherDevice>();
    // ── Voice rings ─────────────────────────────────────────────────────────────
    // Plain `guild.` rather than `guild.voice.`: that prefix is reserved for voice *room state*,
    // which every client must be able to reconstruct from a version number after missing an event.
    // A ring is not room state - its audience is somebody who is not in the room and may never be.
    /** Somebody is asking us into a voice channel. Every device of the target gets it. */
    public voiceRingIncomingObservable = new Subject<WsVoiceRing>();
    /** Our own ring went out. For our *other* windows, so they stop offering to send it again. */
    public voiceRingSentObservable = new Subject<WsVoiceRing>();
    /** One event for every way a ring ends. Sent to both sides, on every device. */
    public voiceRingResolvedObservable = new Subject<WsVoiceRingResolved>();
    /** Addressed to one device that answered a ring somebody else had already answered. */
    public voiceRingDismissedObservable = new Subject<WsVoiceRingDismissed>();
    /** Authoritative room state. Replace everything held for this channel; never merge. */
    public voiceSnapshotObservable = new Subject<VoiceRoomSnapshot>();
    /** "You are behind, refetch." Carries a reason, never a delta. */
    public voiceResyncObservable = new Subject<WsGuildVoiceResync>();
    // ── Channel/category lifecycle ──────────────────────────────────────────────
    public channelCreatedObservable = new Subject<WsChannelCreated>();
    public channelDeletedObservable = new Subject<WsChannelDeleted>();
    /** Encryption was switched on or off for a channel by someone with ManageChannel. */
    public channelMlsStateChangedObservable = new Subject<WsChannelMlsStateChanged>();
    /**
     * A device asked to be admitted to a channel's group. A prompt to re-read the queue, never a
     * decision - see {@link toChannelJoinRequestEvent}.
     */
    public mlsJoinRequestObservable = new Subject<MlsJoinRequestEvent>();
    public categoryCreatedObservable = new Subject<WsCategoryCreated>();
    public categoryUpdatedObservable = new Subject<WsCategoryUpdated>();
    public categoryDeletedObservable = new Subject<WsCategoryDeleted>();
    // ── Wiki lifecycle ──────────────────────────────────────────────────────────
    public wikiPageCreatedObservable = new Subject<WsWikiPageCreated>();
    public wikiPageUpdatedObservable = new Subject<WsWikiPageUpdated>();
    public wikiPageDeletedObservable = new Subject<WsWikiPageDeleted>();
    public wikiCategoryCreatedObservable = new Subject<WsWikiCategoryCreated>();
    public wikiCategoryUpdatedObservable = new Subject<WsWikiCategoryUpdated>();
    public wikiCategoryDeletedObservable = new Subject<WsWikiCategoryDeleted>();
    // ── Personas ───────────────────────────────────────────────────────────────
    public personaProfileChangedObservable = new Subject<WsPersonaProfileChanged>();
    public personaUpdatedObservable = new Subject<WsPersonaUpdated>();
    // ── Scenes ─────────────────────────────────────────────────────────────────
    readonly sceneTurnChangedObservable = new Subject<WsSceneTurnChanged>();
    readonly sceneUpdatedObservable = new Subject<WsSceneUpdated>();
    readonly sceneTurnNudgeObservable = new Subject<WsSceneTurnNudge>();
    // ── Member moderation ──────────────────────────────────────────────────────────
    public memberBannedObservable = new Subject<WsMemberBanned>();
    public memberKickedObservable = new Subject<WsMemberKicked>();
    public memberMovedOutObservable = new Subject<WsMemberMovedOut>();
    public memberMutedObservable = new Subject<WsMemberMuted>();
    public memberUnmutedObservable = new Subject<WsMemberUnmuted>();
    public memberLeftObservable = new Subject<WsMemberLeft>();
    public memberJoinedObservable = new Subject<WsMemberJoined>();
    /** Roles or nickname changed. Consumers must re-read the row, not patch it. */
    public memberUpdatedObservable = new Subject<WsMemberUpdated>();
    // ── Guild lifecycle ────────────────────────────────────────────────────────────
    /**
     * A guild appeared for this account - created on another device, or an invite accepted there.
     * Carries the whole `GuildDto`, so the rail can add it without a round trip.
     */
    public guildCreatedObservable = new Subject<GuildDto>();
    public guildDeletedObservable = new Subject<WsGuildDeleted>();
    public guildUpdatedObservable = new Subject<WsGuildUpdated>();
    // ── Reactions ───────────────────────────────────────────────────────────────
    public reactionAddedObservable = new Subject<ReactionEvent>();
    public reactionRemovedObservable = new Subject<ReactionEvent>();
    public messagePinnedObservable = new Subject<MessagePinnedEvent>();
    public messageUnpinnedObservable = new Subject<MessageUnpinnedEvent>();
    /** A channel message was edited. Same event shape a conversation edit produces. */
    public messageUpdatedObservable = new Subject<MessageUpdatedEvent>();
    /** A moderation action deleted several messages at once. */
    public messagesBulkDeletedObservable = new Subject<WsMessagesBulkDeleted>();
    /** A bot reply only this user can see, and which the server never stored. */
    public ephemeralMessageObservable = new Subject<MessageDto>();
    /**
     * A bot wants a form on screen. The answer goes back over HTTP, not this socket:
     * `POST /bots/guilds/{g}/channels/{c}/modal-submit`, carrying the `customId` from this event
     * and the filled rows.
     */
    public modalOpenObservable = new Subject<WsBotModalOpen>();
    // ── Roles/channels/threads ────────────────────────────────────────────────────
    public rolesReorderedObservable = new Subject<ReorderRolesDto>();
    public channelUpdatedObservable = new Subject<WsChannelUpdated>();
    public threadCreatedObservable = new Subject<WsThreadCreated>();
    public threadUpdatedObservable = new Subject<WsThreadUpdated>();
    // ── Forums ──────────────────────────────────────────────────────────────────
    public forumTagCreatedObservable = new Subject<WsForumTagEvent>();
    public forumTagUpdatedObservable = new Subject<WsForumTagEvent>();
    public forumTagDeletedObservable = new Subject<WsForumTagDeleted>();
    public forumTagsReorderedObservable = new Subject<WsForumTagsReordered>();
    public forumConfigUpdatedObservable = new Subject<WsForumConfigUpdated>();
    public emojiCreatedObservable = new Subject<WsEmojiCreated>();
    public emojiDeletedObservable = new Subject<WsEmojiDeleted>();
    // ── Presence ────────────────────────────────────────────────────────────────
    public presenceChangedObservable = new Subject<WsPresenceChanged>();
    // ── Bot lifecycle ──────────────────────────────────────────────────────────
    public botInstalledObservable = new Subject<WsBotInstalled>();
    public botUninstalledObservable = new Subject<WsBotUninstalled>();
    // ── Scheduled events ────────────────────────────────────────────────────────
    readonly eventCreatedObservable = new Subject<WsEventCreated>();
    readonly eventUpdatedObservable = new Subject<WsEventUpdated>();
    readonly eventCancelledObservable = new Subject<WsEventCancelled>();
    private realtime = inject(RealtimeConnectionService);
    private privacy = inject(PrivacySettingsService);
    private notificationService = inject(NotificationService);
    private profileService = inject(ProfileService);
    private userActivityService = inject(UserActivityService);
    private mlsService = inject(MlsService);
    private mlsHealth = inject(MlsHealthService);
    private listenersSetUp = false;
    // See MessagingWebsocketService.notifiedMessageIds -guards against SignalR
    // redelivering 'guild.MessageCreated' after a reconnect and double-firing the sound.
    private readonly notifiedMessageIds = new Set<string>();

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

    /** Suppressed when the account has turned typing indicators off (T2-18). See the note on the
     * messaging equivalent for why read state is not gated with it. */
    invokeStartTyping(channelId: string): void {
        if (!this.privacy.sendTypingIndicators()) return;
        void this.realtime.invoke('guild.StartTyping', channelId);
    }

    async updateLastReadMessageByChannel(id: string, channelId: string): Promise<void> {
        await this.realtime.invoke('guild.UpdateLastRead', {channelId, id});
    }

    invokeVoiceMuteChanged(channelId: string, isMuted: boolean): void {
        void this.realtime.invoke('guild.voice.MuteChanged', {channelId, isMuted});
    }

    // ── Voice invoke methods (client → server) ───────────────────────────────────

    invokeVoiceDeafenChanged(channelId: string, isDeafened: boolean): void {
        void this.realtime.invoke('guild.voice.DeafenChanged', {channelId, isDeafened});
    }

    invokeVoiceCameraChanged(channelId: string, isCameraOn: boolean): void {
        void this.realtime.invoke('guild.voice.CameraChanged', {channelId, isCameraOn});
    }

    invokeVoiceScreenShareStarted(channelId: string, shareId: string): void {
        void this.realtime.invoke('guild.voice.ScreenShareStarted', {channelId, shareId});
    }

    invokeVoiceScreenShareStopped(channelId: string, shareId: string): void {
        void this.realtime.invoke('guild.voice.ScreenShareStopped', {channelId, shareId});
    }

    /**
     * The state-asserting heartbeat: liveness *and* the repair channel.
     *
     * <p>Restating what this client believes is what lets the server correct it. The old
     * `guild.voice.Heartbeat` took no arguments, so the server could learn a client was alive but
     * never that it was <em>wrong</em>, and a missed event stayed missed for the whole session.</p>
     *
     * <p>Report honestly. Passing a session id while not publishing makes peers attempt a subscribe
     * that cannot succeed; passing null while publishing has the server tell them to drop us.</p>
     */
    invokeVoiceHeartbeat(channelId: string, state: VoiceHeartbeatState): void {
        void this.realtime.invoke('voice.Heartbeat', 'channel', channelId, state);
    }

    private setupListeners(): void {
        // Friend requests are handled by SocialWebsocketService (the `social.*` events).
        // With a single shared connection each event must only be registered once, so the
        // former duplicate handler here is removed.

        this.realtime.on('guild.ChannelReordered', (data: ReorderChannesDto) => {
            this.channelReorderedObservable.next(data);
        });

        this.realtime.on('guild.UserTyping', (data: ChannelTypingEvent) => {
            this.userTypingObservable.next(data);
        });

        // ── Guild voice presence ────────────────────────────────────────────────
        this.realtime.on('guild.voice.UserJoinedVoice', (d: WsUserJoinedVoice) =>
            this.userJoinedVoiceObservable.next(d),
        );
        this.realtime.on('guild.voice.UserLeftVoice', (d: WsUserLeftVoice) =>
            this.userLeftVoiceObservable.next(d),
        );
        this.realtime.on('guild.voice.ParticipantJoined', (d: WsGuildParticipantJoined) =>
            this.guildParticipantJoinedObservable.next(d),
        );
        this.realtime.on('guild.voice.TrackPublished', (d: WsGuildTrackPublished) =>
            this.guildTrackPublishedObservable.next(d),
        );
        this.realtime.on('guild.voice.TrackClosed', (d: WsGuildTrackClosed) =>
            this.guildTrackClosedObservable.next(d),
        );
        this.realtime.on('guild.voice.MuteChanged', (d: WsVoiceMuteChanged) =>
            this.voiceMuteChangedObservable.next(d),
        );
        this.realtime.on('guild.voice.DeafenChanged', (d: WsVoiceDeafenChanged) =>
            this.voiceDeafenChangedObservable.next(d),
        );
        this.realtime.on('guild.voice.CameraChanged', (d: WsVoiceCameraChanged) =>
            this.voiceCameraChangedObservable.next(d),
        );
        this.realtime.on('guild.voice.ScreenShareStarted', (d: WsVoiceScreenShareStarted) =>
            this.voiceScreenShareStartedObservable.next(d),
        );
        this.realtime.on('guild.voice.ScreenShareStopped', (d: WsVoiceScreenShareStopped) =>
            this.voiceScreenShareStoppedObservable.next(d),
        );
        this.realtime.on('guild.voice.ShareViewersChanged', (d: ShareViewersDto) =>
            this.shareViewersChangedObservable.next(d),
        );
        this.realtime.on('guild.voice.MovedToChannel', (d: WsMovedToChannel) =>
            this.movedToChannelObservable.next(d),
        );
        this.realtime.on('guild.voice.KickedByOtherDevice', (d: WsKickedByOtherDevice) =>
            this.kickedByOtherDeviceObservable.next(d),
        );

        // ── Voice rings ─────────────────────────────────────────────────────────
        this.realtime.on('guild.VoiceRingIncoming', (d: WsVoiceRing) =>
            this.voiceRingIncomingObservable.next(d),
        );
        this.realtime.on('guild.VoiceRingSent', (d: WsVoiceRing) => this.voiceRingSentObservable.next(d));
        this.realtime.on('guild.VoiceRingResolved', (d: WsVoiceRingResolved) =>
            this.voiceRingResolvedObservable.next(d),
        );
        this.realtime.on('guild.VoiceRingDismissed', (d: WsVoiceRingDismissed) =>
            this.voiceRingDismissedObservable.next(d),
        );

        // ── Recovery ────────────────────────────────────────────────────────────
        // Pushed on join, on publish, and whenever the server decides we are out of date. The
        // snapshot is authoritative and sufficient on its own - it is not a delta and must not be
        // merged with what is already held.
        this.realtime.on('guild.voice.Snapshot', (d: VoiceRoomSnapshot) =>
            this.voiceSnapshotObservable.next(d),
        );
        this.realtime.on('guild.voice.Resync', (d: WsGuildVoiceResync) => this.voiceResyncObservable.next(d));
        this.realtime.on('guild.ChannelCreated', (d: WsChannelCreated) =>
            this.channelCreatedObservable.next(d),
        );
        this.realtime.on('guild.ChannelDeleted', (d: WsChannelDeleted) =>
            this.channelDeletedObservable.next(d),
        );
        this.realtime.on('guild.ChannelMlsStateChanged', (d: WsChannelMlsStateChanged) =>
            this.channelMlsStateChangedObservable.next(d),
        );
        this.realtime.on('guild.CategoryCreated', (d: WsCategoryCreated) =>
            this.categoryCreatedObservable.next(d),
        );
        this.realtime.on('guild.CategoryUpdated', (d: WsCategoryUpdated) =>
            this.categoryUpdatedObservable.next(d),
        );
        this.realtime.on('guild.CategoryDeleted', (d: WsCategoryDeleted) =>
            this.categoryDeletedObservable.next(d),
        );
        this.realtime.on('guild.WikiPageCreated', (d: WsWikiPageCreated) =>
            this.wikiPageCreatedObservable.next(d),
        );
        this.realtime.on('guild.WikiPageUpdated', (d: WsWikiPageUpdated) =>
            this.wikiPageUpdatedObservable.next(d),
        );
        this.realtime.on('guild.WikiPageDeleted', (d: WsWikiPageDeleted) =>
            this.wikiPageDeletedObservable.next(d),
        );
        this.realtime.on('guild.WikiCategoryCreated', (d: WsWikiCategoryCreated) =>
            this.wikiCategoryCreatedObservable.next(d),
        );
        this.realtime.on('guild.WikiCategoryUpdated', (d: WsWikiCategoryUpdated) =>
            this.wikiCategoryUpdatedObservable.next(d),
        );
        this.realtime.on('guild.WikiCategoryDeleted', (d: WsWikiCategoryDeleted) =>
            this.wikiCategoryDeletedObservable.next(d),
        );
        this.realtime.on('guild.PersonaProfileChanged', (d: WsPersonaProfileChanged) =>
            this.personaProfileChangedObservable.next(d),
        );
        this.realtime.on('guild.PersonaUpdated', (d: WsPersonaUpdated) =>
            this.personaUpdatedObservable.next(d),
        );
        this.realtime.on('guild.SceneTurnChanged', (d: WsSceneTurnChanged) =>
            this.sceneTurnChangedObservable.next(d),
        );
        this.realtime.on('guild.SceneUpdated', (d: WsSceneUpdated) => this.sceneUpdatedObservable.next(d));
        this.realtime.on('guild.SceneTurnNudge', (d: WsSceneTurnNudge) =>
            this.sceneTurnNudgeObservable.next(d),
        );
        this.realtime.on('guild.MemberBanned', (d: WsMemberBanned) => this.memberBannedObservable.next(d));
        this.realtime.on('guild.MemberKicked', (d: WsMemberKicked) => this.memberKickedObservable.next(d));
        this.realtime.on('guild.MemberMovedOut', (d: WsMemberMovedOut) =>
            this.memberMovedOutObservable.next(d),
        );
        this.realtime.on('guild.MemberMuted', (d: WsMemberMuted) => this.memberMutedObservable.next(d));
        this.realtime.on('guild.MemberUnmuted', (d: WsMemberUnmuted) => this.memberUnmutedObservable.next(d));
        this.realtime.on('guild.MemberLeft', (d: WsMemberLeft) => this.memberLeftObservable.next(d));
        this.realtime.on('guild.MemberJoined', (d: WsMemberJoined) => this.memberJoinedObservable.next(d));
        this.realtime.on('guild.MemberUpdated', (d: WsMemberUpdated) => this.memberUpdatedObservable.next(d));
        this.realtime.on('guild.GuildCreated', (d: GuildDto) => this.guildCreatedObservable.next(d));
        this.realtime.on('guild.GuildDeleted', (d: WsGuildDeleted) => this.guildDeletedObservable.next(d));
        this.realtime.on('guild.GuildUpdated', (d: WsGuildUpdated) => this.guildUpdatedObservable.next(d));
        this.realtime.on('guild.RolesReordered', (d: ReorderRolesDto) =>
            this.rolesReorderedObservable.next(d),
        );
        this.realtime.on('guild.ChannelUpdated', (d: WsChannelUpdated) =>
            this.channelUpdatedObservable.next(d),
        );
        this.realtime.on('guild.ThreadCreated', (d: WsThreadCreated) => this.threadCreatedObservable.next(d));
        this.realtime.on('guild.ThreadUpdated', (d: WsThreadUpdated) => this.threadUpdatedObservable.next(d));
        this.realtime.on('guild.ForumTagCreated', (d: WsForumTagEvent) =>
            this.forumTagCreatedObservable.next(d),
        );
        this.realtime.on('guild.ForumTagUpdated', (d: WsForumTagEvent) =>
            this.forumTagUpdatedObservable.next(d),
        );
        this.realtime.on('guild.ForumTagDeleted', (d: WsForumTagDeleted) =>
            this.forumTagDeletedObservable.next(d),
        );
        this.realtime.on('guild.ForumTagsReordered', (d: WsForumTagsReordered) =>
            this.forumTagsReorderedObservable.next(d),
        );
        this.realtime.on('guild.ForumConfigUpdated', (d: WsForumConfigUpdated) =>
            this.forumConfigUpdatedObservable.next(d),
        );
        this.realtime.on('guild.EmojiCreated', (d: WsEmojiCreated) => this.emojiCreatedObservable.next(d));
        this.realtime.on('guild.EmojiDeleted', (d: WsEmojiDeleted) => this.emojiDeletedObservable.next(d));
        this.realtime.on('guild.EventCreated', (d: WsEventCreated) => this.eventCreatedObservable.next(d));
        this.realtime.on('guild.EventUpdated', (d: WsEventUpdated) => this.eventUpdatedObservable.next(d));
        this.realtime.on('guild.EventCancelled', (d: WsEventCancelled) =>
            this.eventCancelledObservable.next(d),
        );

        this.realtime.on('guild.PresenceChanged', (d: WsPresenceChanged) => {
            this.presenceChangedObservable.next(d);
            this.profileService.setOnlineStatus(d.userId, d.status);
            // Kept out of `ProfileService` on purpose: status patches a cached profile and is lost
            // for anyone uncached, which activity cannot afford. See {@link UserActivityService}.
            if (d.activities !== undefined) this.userActivityService.set(d.userId, d.activities);
        });

        this.realtime.on('guild.ReactionCreated', (d: ReactionEvent) => this.reactionAddedObservable.next(d));
        this.realtime.on('guild.ReactionRemoved', (d: ReactionEvent) =>
            this.reactionRemovedObservable.next(d),
        );

        this.realtime.on('guild.MessagePinned', (d: MessagePinnedEvent) =>
            this.messagePinnedObservable.next(d),
        );
        this.realtime.on('guild.MessageUnpinned', (d: MessageUnpinnedEvent) =>
            this.messageUnpinnedObservable.next(d),
        );

        // Not logged, for the same reason `conversation.MessageUpdated` is not: the payload carries
        // the edited body, which in a plaintext channel is the message itself, and this console
        // ships in release builds.
        this.realtime.on('guild.MessageUpdated', (d: GuildMessageUpdatedPayload) => {
            this.messageUpdatedObservable.next(mapGuildMessageUpdatedPayload(d));
        });

        this.realtime.on('guild.MessagesBulkDeleted', (d: WsMessagesBulkDeleted) => {
            this.messagesBulkDeletedObservable.next(d);
        });

        this.realtime.on('guild.EphemeralMessageCreated', (d: GuildEphemeralMessagePayload) => {
            this.ephemeralMessageObservable.next(mapGuildEphemeralMessagePayload(d));
        });

        this.realtime.on('guild.ModalOpen', (d: WsBotModalOpen) => this.modalOpenObservable.next(d));

        // A device wants into a channel's group. Nothing is decided here; the review surface
        // re-reads the queue over HTTP, which is the only place the key package exists.
        this.realtime.on('guild.ChannelMlsJoinRequested', (d: WsChannelMlsJoinRequested) => {
            this.mlsJoinRequestObservable.next(toChannelJoinRequestEvent(d));
        });

        this.realtime.on('guild.BotInstalled', (d: WsBotInstalled) => this.botInstalledObservable.next(d));
        this.realtime.on('guild.BotUninstalled', (d: WsBotUninstalled) =>
            this.botUninstalledObservable.next(d),
        );

        this.realtime.on('guild.MessageCreated', async (data: GuildMessageCreatedPayload) => {
            // Not logged. The payload carries `content`, so this printed every message body in a
            // plaintext channel to a console that ships in release builds.
            let message = mapGuildMessageCreatedPayload(data);

            // <b>This path hardcodes `encryptionState: Plain` and never decrypts.</b> It goes
            // straight into the store, so a channel this device has encrypted would have the
            // server's own bytes rendered under a real member's name here regardless of what the
            // conversation path refuses - §L.9's "server-supplied encryption state must not be
            // able to downgrade a context" applied to the other socket. Marked unverified rather
            // than decrypted: wiring the decryptor into this path is a larger change, and refusing
            // to render is the safe half of it.
            const contextId = data.channelId ?? data.conversationId;
            if (contextId && (await this.mlsService.getEncryptionFloor(contextId)) !== null) {
                this.mlsHealth.recordFailure(
                    contextId,
                    !!data.channelId,
                    'downgraded',
                    `message ${data.messageId} arrived on the guild socket as cleartext in a ` +
                        `context this device has encrypted`,
                );
                message = {...message, undecryptable: true};
            }

            this.messageObservable.next(message);

            const ownId = this.profileService.ownProfile()?.userId;
            const mentions = data.mentions ?? [];
            if (ownId && mentions.includes(ownId) && this.markNotified(data.messageId)) {
                // Empty rather than decoded when the mapped message came back unverified. A
                // notification body escapes the app entirely - into the OS notification centre,
                // where it persists and is not governed by anything in the UI - so it is the last
                // place an unauthenticated body should be allowed to surface. The DM path already
                // blanks it; this one did not.
                const body = message.undecryptable ? '' : decodeBody(data.content);
                const sender = await firstValueFrom(
                    this.profileService.getByUserId(data.authorId).pipe(
                        timeout(5_000),
                        catchError(() => of(null)),
                    ),
                );
                await this.notificationService.createNotification({
                    title: `${sender?.userName ?? 'Someone'} mentioned you`,
                    message: body,
                    profile: sender ?? undefined,
                    sound: NotificationSound.NewMessage,
                    category: 'mention',
                    extra: {channelId: data.channelId},
                });
            }
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
