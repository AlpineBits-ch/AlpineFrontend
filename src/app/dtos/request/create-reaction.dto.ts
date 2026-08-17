export interface CreateReactionDto {
    /** Omit entirely for custom-emoji reactions - the server rejects emojiId + conversationId together. */
    conversationId?: string;
    reaction?: string;
    channelId?: string;
    emojiId?: string;
}
