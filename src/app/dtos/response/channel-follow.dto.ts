export interface ChannelFollowDto {
    id: string;
    targetChannelId: string;
    targetGuildId: string;
    createdByUserId: string;
    createdAt: string;
}

/** Response from creating a follow - narrower than the list shape. */
export interface CreatedChannelFollowDto {
    id: string;
    sourceChannelId: string;
    targetChannelId: string;
}

export interface PublishResponse {
    /** Number of channels the copy landed in. Zero is a success, not an error. */
    published: number;
}
