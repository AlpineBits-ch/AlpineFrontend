import { MessageEncryptionState } from '../../enums/message-encryption-state.enum';

export interface CreateMessageDto {
    content: string;
    conversationId: string | undefined;
    channelId: string | undefined;
    attachments: string[];
    inReplyTo: string | undefined;
    mentions: string[];
    encryptionState?: MessageEncryptionState;
    mlsEpoch?: number;
    senderDeviceId?: string;
}
