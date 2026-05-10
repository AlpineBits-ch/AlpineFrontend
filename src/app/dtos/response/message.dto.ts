import {MessageEncryptionState} from "../../enums/message-encryption-state.enum";

import { MessageType } from '../../enums/message-type.enum';

export interface MessageAttachment {
  id: string;
  fileName: string;
  contentType: string;
  url: string;
  thumbnailUrl?: string;
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
    encryptionState: MessageEncryptionState;
    mlsEpoch: number | undefined;
    mlsSequenceNumber: number | undefined;
    senderDeviceId: string | undefined;
    type: MessageType;
}
