export interface GuildEmojiDto {
    id: string;
    guildId: string;
    name: string;
    animated: boolean;
    createdByUserId: string;
    createdAt: string;
    /** Presigned, expires ~1h - refetch the list (not just this URL) once it's been an hour. */
    imageUrl: string;
}
