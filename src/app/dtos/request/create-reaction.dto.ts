export interface CreateReactionDto {
    conversationId: string;
    reaction?: string;
    channelId?: string;
    emojiId?: string;
}
