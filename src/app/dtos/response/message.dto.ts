export interface MessageDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    content: unknown,
    channelId: string | undefined;
    conversationId: string | undefined;
    authorId: string;
}