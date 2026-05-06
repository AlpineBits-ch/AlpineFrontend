export interface CreateMessageDto {
    content: string;
    conversationId: string | undefined;
    channelId: string | undefined;
    attachments: string[];
    inReplyTo: string | undefined;
    mentions: string[];
}