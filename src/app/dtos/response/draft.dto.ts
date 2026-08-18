/** One unsent message, kept for one user in one channel or conversation, synced to that user's own devices. */
export interface MessageDraftDto {
    /** The channel or conversation id. The other two are the same id, split by which kind it is. */
    contextId: string;
    channelId: string | null;
    conversationId: string | null;
    content: string;
    inReplyTo: string | null;
    /** Attachment ids already uploaded. Absent from a server that predates draft attachments. */
    attachments?: string[] | null;
    updatedAt: string;
    /** Which device wrote it, set only on the answer to that device's own write. */
    deviceId?: string | null;
}

export interface SaveMessageDraftDto {
    content: string;
    inReplyTo?: string | null;
    attachments?: string[];
}
