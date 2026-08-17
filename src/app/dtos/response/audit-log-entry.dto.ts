export type AuditLogActionType =
    | 'MemberBanned' | 'MemberUnbanned' | 'MemberKicked' | 'MemberMuted' | 'MemberUnmuted' | 'MemberLeft'
    | 'RoleCreated' | 'RoleUpdated' | 'RoleDeleted' | 'RolePositionsChanged'
    | 'ChannelCreated' | 'ChannelDeleted' | 'ChannelUpdated' | 'ChannelPermissionChanged'
    | 'CategoryCreated' | 'CategoryDeleted'
    | 'GuildUpdated' | 'GuildDeleted'
    | 'InviteCreated' | 'InviteDeleted';

export interface AuditLogEntryDto {
    id: string;
    guildId: string;
    actorUserId: string;
    actionType: AuditLogActionType;
    targetId: string | null;
    /** JSON-encoded string, not a nested object - caller must JSON.parse it. */
    metadata: string | null;
    createdAt: string;
}
