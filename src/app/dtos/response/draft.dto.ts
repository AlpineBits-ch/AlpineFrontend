/** One unsent message, kept for one user in one channel and synced to that user's own devices. */
export interface MessageDraftDto {
    channelId: string;
    content: string;
    updatedAt: string;
}

export interface SaveMessageDraftDto {
    content: string;
}
