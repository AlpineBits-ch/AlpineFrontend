import {MessageEncryptionState} from '../../enums/message-encryption-state.enum';

export interface CreateMessageDto {
    content: string;
    conversationId: string | undefined;
    channelId: string | undefined;
    attachments: string[];
    inReplyTo: string | undefined;
    mentions: string[];
    roleMentions?: string[];
    mentionsEveryone?: boolean;
    mentionsHere?: boolean;
    encryptionState?: MessageEncryptionState;
    mlsEpoch?: number;
    /** Which encryption era of the context the ciphertext was sealed under. */
    mlsGeneration?: number;
    senderDeviceId?: string;
}
