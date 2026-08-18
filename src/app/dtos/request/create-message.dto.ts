import {MessageEncryptionState} from '../../enums/message-encryption-state.enum';

export interface CreateMessageDto {
    content: string;
    conversationId: string | undefined;
    channelId: string | undefined;
    attachments: string[];
    inReplyTo: string | undefined;
    mentions: string[];
    /** Characters named in the body as `<@pers_...>`. Notifies each owner without naming them. */
    personaMentions?: string[];
    roleMentions?: string[];
    mentionsEveryone?: boolean;
    mentionsHere?: boolean;
    /** Speak as this character. The server resolves it and fills the author display overrides. */
    personaId?: string;
    encryptionState?: MessageEncryptionState;
    mlsEpoch?: number;
    /** Which encryption era of the context the ciphertext was sealed under. */
    mlsGeneration?: number;
    senderDeviceId?: string;
}
