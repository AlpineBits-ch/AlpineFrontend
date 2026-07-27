export interface ManageableGuildDto {
    id: string;
    name: string;
    description: string;
    installed: boolean;
}

export interface BotAuthorizeInfoDto {
    applicationId: string;
    name: string;
    iconUrl: string;
    description: string;
    guildId: string;
    requestedPermissions: string;
    grantablePermissions: string;
}

export interface BotInstallResultDto {
    guildId: string;
    grantedPermissions: string;
}
