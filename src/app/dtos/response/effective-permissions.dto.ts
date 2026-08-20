import {PermissionKey} from '../../enums/permissions.enum';

/** The layer that last wrote a bit. Server enum names, so never rename one locally. */
export type PermissionSourceKey =
    | 'Base'
    | 'MemberGuildAllow'
    | 'MemberGuildDeny'
    | 'CategoryEveryoneAllow'
    | 'CategoryEveryoneDeny'
    | 'CategoryRoleAllow'
    | 'CategoryRoleDeny'
    | 'CategoryMemberAllow'
    | 'CategoryMemberDeny'
    | 'ChannelEveryoneAllow'
    | 'ChannelEveryoneDeny'
    | 'ChannelRoleAllow'
    | 'ChannelRoleDeny'
    | 'ChannelMemberAllow'
    | 'ChannelMemberDeny'
    | 'Implied'
    | 'Superadmin'
    | 'Muted';

export interface PermissionSourceEntry {
    permission: PermissionKey;
    granted: boolean;
    decidedBy: PermissionSourceKey;
}

/** What one role or member ends up with in one channel, and why. */
export interface EffectivePermissionsDto {
    channelId: string;
    subjectKind: 'Role' | 'Member';
    subjectId: string;
    permissions: string;
    modulePermissions: string;
    sources: PermissionSourceEntry[];
}
