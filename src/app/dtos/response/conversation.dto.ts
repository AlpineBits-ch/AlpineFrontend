import { ConversationEncryption } from '../../enums/conversation-encryption.enum';

export interface ConversationMemberDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    userId: string;
    cachedUserName: string;
    cachedUserHash: number;
    lastReadMessageId: string | undefined;
    mentionCount: number;
}

export interface ConversationDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    name: string | undefined;
    members: ConversationMemberDto[];
    encryption: ConversationEncryption;
}
