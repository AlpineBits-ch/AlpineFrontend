import {MessageEncryptionState} from "../../enums/message-encryption-state.enum";
import {MessageType} from '../../enums/message-type.enum';

export interface MessageAttachment {
    id: string;
    fileName: string;
    contentType: string;
    url: string;
    thumbnailUrl?: string;
}

export interface MessageReaction {
    contextId: string;
    messageId: string;
    emoji: string;
    emojiId?: string | null;
    userId: string;
    createdAt: string;
    conversationId: string | null;
    channelId: string | null;
}

export interface MessageEmbedField {
    name: string;
    value: string;
    inline: boolean;
}

export interface MessageEmbedAuthor {
    name: string;
}

export interface MessageEmbedFooter {
    text: string;
}

export interface MessageEmbed {
    title?: string;
    description?: string;
    url?: string;
    color?: string;
    author?: MessageEmbedAuthor;
    fields: MessageEmbedField[];
    footer?: MessageEmbedFooter;
}

export interface MessageDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    content: string;
    channelId: string | undefined;
    conversationId: string | undefined;
    authorId: string;
    isPending: boolean;
    isFailed: boolean;
    attachments: MessageAttachment[];
    inReplyTo: string | undefined;
    mentions: string[];
    roleMentions?: string[];
    mentionsEveryone?: boolean;
    mentionsHere?: boolean;
    encryptionState: MessageEncryptionState;
    mlsEpoch: number | undefined;
    mlsSequenceNumber: number | undefined;
    /** Which encryption era of the context this ciphertext belongs to. Null on plaintext. */
    mlsGeneration?: number | null;
    /** Client-only: ciphertext this device can no longer read - MLS ratchets forward only. */
    undecryptable?: boolean;
    senderDeviceId: string | undefined;
    type: MessageType;
    reactions?: MessageReaction[];
    /** Client-only: marks this entity as a synthetic placeholder for an in-flight/failed bot command invocation, not a real persisted message. */
    isBotCommandPlaceholder?: boolean;
    embedsJson?: string;
    systemMessageVariant?: number;
    isPinned?: boolean;
    pinnedAt?: string;
    pinnedById?: string;
}

export interface PinMessageResponse {
    success: boolean;
    channelId?: string;
    conversationId?: string;
    authorId?: string;
    pinnedById?: string;
    pinnedAt?: string;
}
