export interface BanDto {
    id: string;
    guildId: string;
    userId: string;
    reason: string | undefined;
    createdAt: Date;
}
