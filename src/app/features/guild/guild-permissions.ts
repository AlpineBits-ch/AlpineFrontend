import {GuildMemberDto} from '../../dtos/response/member.dto';
import {hasPermission, parsePermissions, PermissionValue, Permissions} from '../../enums/permissions.enum';

/**
 * A member's own permission bits unioned with every role they hold.
 *
 * Roles are where nearly all real permissions live, so reading `member.permissions`
 * alone reports far less access than the member actually has.
 */
export function effectiveGuildPermissions(member: GuildMemberDto | null | undefined): PermissionValue {
    if (!member) return 0n;

    const merged = (member.roleMembers ?? []).reduce((acc, {role}) => {
        if (!role.permissions) return acc;
        return acc === '' ? role.permissions : `${acc},${role.permissions}`;
    }, member.permissions ?? '');

    return parsePermissions(merged);
}

/**
 * Who may open server settings: the guild owner, anyone holding Superadmin, or anyone
 * holding ManageGuild. The owner is tested first because SelfGuildMemberDto.permissions
 * does not reliably carry Superadmin for them.
 *
 * A missing `member` means "not loaded yet", not "no roles", and is reported as denied.
 * Callers must therefore only treat a `false` as final once the member has arrived -
 * failing closed while loading is deliberate, so the entry point is never briefly offered
 * to someone who turns out not to have the permission.
 */
export function memberCanManageGuild(
    member: GuildMemberDto | null | undefined,
    ownerId: string | null | undefined,
    ownUserId: string | null | undefined,
): boolean {
    if (ownUserId && ownerId && ownUserId === ownerId) return true;
    if (!member) return false;

    const perms = effectiveGuildPermissions(member);
    return hasPermission(perms, Permissions.Superadmin) || hasPermission(perms, Permissions.ManageGuild);
}
