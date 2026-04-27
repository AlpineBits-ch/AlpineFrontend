export interface CreateMessageDto {
    content: string;
    conversationId: string | undefined;
    channelId: string | undefined;
}