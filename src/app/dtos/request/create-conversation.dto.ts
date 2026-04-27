import {ConversationEncryption} from "../../enums/conversation-encryption.enum";

export interface CreateConversationMemberDto {
    userId: string;
}
export interface CreateConversationDto {
    name: string | undefined;
    members: CreateConversationMemberDto[];
    encryption: ConversationEncryption
}