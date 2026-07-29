export type ImportJobStatus = 'Pending' | 'FetchingFromDiscord' | 'CreatingGuild' | 'Completed' | 'Failed';

export interface ImportJobDto {
    jobId: string;
    status: ImportJobStatus;
    guildId?: string;
    errorMessage?: string;
}

export type GuildLinkStatus = 'Active' | 'Paused' | 'Revoked';
export type GuildLinkSyncDirection = 'DiscordToVenta' | 'VentaToDiscord' | 'Bidirectional';

export interface GuildLinkDto {
    id: string;
    guildId: string;
    discordGuildId: string;
    discordGuildName: string;
    status: GuildLinkStatus;
    syncDirection: GuildLinkSyncDirection;
    createdAt: string;
}

export interface StartImportResponseDto {
    authorizeUrl: string;
}
