export interface AuthorizeBotDto {
    clientId: string;
    guildId: string;
    permissions: string;
    redirectUri?: string;
}
