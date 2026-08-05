import {GuildMemberDto, SelfGuildMemberDto} from '../../dtos/response/member.dto';
import {hasPermission, parsePermissions, PermissionValue, Permissions} from '../../enums/permissions.enum';

/**
 * What a member may actually do in this guild.
 *
 * Prefers the server's own answer (`effectivePermissions` on `GET /guilds/{id}/me`), which is the
 * same mask every endpoint gates on: ownership, all roles, member allow/deny, implied bits, and
 * the clamp to enabled modules.
 *
 * The fallback below - a union of the member's own bits with every role they hold - is what this
 * used to do unconditionally, and it has one blind spot that matters: it cannot see ownership. The
 * owner's member row carries no permissions and their only role is @everyone, so the union reports
 * an ordinary member and every call site has to remember to check `guild.ownerId` separately.
 * Keep the fallback for callers holding a plain `GuildMemberDto` and for a server that has not
 * shipped the field yet; treat its result as incomplete for the owner.
 */
export function effectiveGuildPermissions(member: GuildMemberDto | null | undefined): PermissionValue {
    if (!member) return 0n;

    const resolved = (member as SelfGuildMemberDto).effectivePermissions;
    // Only an absent field falls through. An empty string is a real answer - "no permissions" -
    // and must not be quietly upgraded to the union.
    if (resolved !== undefined && resolved !== null) return parsePermissions(resolved);

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
