import {ChannelDto, RoleDto} from '../../../../../../dtos/response/guild.dto';
import {hasPermission, parsePermissions, Permissions} from '../../../../../../enums/permissions.enum';

/** Channels this role carries an explicit permission override on. */
export function countRoleOverrides(role: RoleDto, channels: readonly ChannelDto[]): number {
    return channels.filter(c => c.permissions.some(p => p.roleId === role.id)).length;
}

/**
 * Channels the role can see: its own base permission, unless a channel-level override for this
 * role turns visibility off or on. Ignores every other role a member might also hold, since this
 * is a property of the role in isolation, not of any one member.
 */
export function countVisibleChannels(role: RoleDto, channels: readonly ChannelDto[]): number {
    const base = hasPermission(parsePermissions(role.permissions), Permissions.ViewChannel);
    return channels.filter(c => isChannelVisibleToRole(c, role.id, base)).length;
}

function isChannelVisibleToRole(channel: ChannelDto, roleId: string, base: boolean): boolean {
    const override = channel.permissions.find(p => p.roleId === roleId);
    if (!override) return base;

    if (hasPermission(parsePermissions(override.denyPermissions), Permissions.ViewChannel)) return false;
    if (hasPermission(parsePermissions(override.allowPermissions), Permissions.ViewChannel)) return true;
    return base;
}
