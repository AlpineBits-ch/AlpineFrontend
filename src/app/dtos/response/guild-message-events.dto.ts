import {MessageDto, MessageEmbed} from './message.dto';
import {MessageUpdatedEvent} from '../../services/messaging-websocket.service';
import {AttachmentDto} from '../../services/file.service';
import {MessageEncryptionState} from '../../enums/message-encryption-state.enum';
import {MessageType} from '../../enums/message-type.enum';
import {toBase64} from '../../helpers/base64.helper';
import {BotComponentPayload} from '../bot-component.dto';

export interface GuildMessageCreatedPayload {
    messageId: string;
    /**
     * The message's stored timestamp, not this device's receipt time.
     *
     * Optional only so a client can outlive a server that predates it; every live server sends it.
     * Falling back to `new Date()` drifts by however long the message spent on the broker.
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
    /** Message bitfield. A message can arrive already suppressed, from a restored edit or a backfill. */
    flags?: number;
    editedAt?: string | null;
    type: string;
    systemMessageVariant: number | undefined;
    /** The character this was spoken as. `authorId` stays the account either way. */
    personaId?: string | null;
    /** Set for a persona post and for a webhook execution, which has no character behind it. */
    authorDisplayName?: string | null;
    authorAvatarUrl?: string | null;
}

/**
 * A message body as it comes off the guild socket.
 *
 * Server-side it is a `byte[]`. System.Text.Json writes those as base64 and that is what every live
 * server sends, but the generated contract describes the field as an array of integers. Both are
 * accepted rather than betting on one, because everything downstream base64-decodes the body
 * unconditionally: a raw byte array reaching the UI renders as `[104,105]`, and `decodeBody`'s
 * tolerant fallback would hand that straight through as if it were the author's words.
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

/** `guild.MessageUpdated`, a channel message was edited. */
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
 * Shared shape on purpose: `MessageStore.applyRemoteUpdate` decides encrypted from plaintext by
 * looking at the stored message rather than the event, so a channel edit routed through it gets the
 * identical treatment, decrypted against the generation the message was sealed under and marked
 * `undecryptable` rather than rendered when that fails.
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

/** One guild message was deleted. */
export interface WsMessageDeleted {
    guildId: string;
    channelId: string;
    messageId: string;
    authorId?: string;
}

/** Moderation deleted a run of messages in one action. */
export interface WsMessagesBulkDeleted {
    guildId: string;
    channelId: string;
    /** Every id removed, as one list. See the store's handler for why that matters. */
    messageIds: string[];
    actorUserId: string;
}

/**
 * `guild.EphemeralMessageCreated`, a bot reply only this user gets and which the server never
 * stored. It exists exactly as long as the tab does.
 */
export interface GuildEphemeralMessagePayload {
    id: string;
    guildId?: string | null;
    channelId: string;
    /** Plain text here, unlike every other message body on this socket. See the mapper. */
    content: string;
    embeds?: MessageEmbed[];
    components?: BotComponentPayload[];
    authorId: string;
    createdAt: string;
}

/**
 * Turns an ephemeral push into something the channel can render.
 *
 * The body is re-encoded, not passed through. This is the one message event whose `content` is
 * already text, and the message bubble decodes unconditionally with `atob`, so a plain sentence
 * that happens to be valid base64 ("test" is) would render as mojibake.
 *
 * `isEphemeral` is what keeps it out of history: the store is in-memory either way, but the flag
 * stops the UI offering edit, delete and pin on something with no server-side row to act on.
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
        // A dice roll answers with the roll, never the message, so this socket is the only place
        // its character ever arrives, including for the person who rolled it.
        personaId: data.personaId,
        authorDisplayName: data.authorDisplayName,
        authorAvatarUrl: data.authorAvatarUrl,
    };
}
