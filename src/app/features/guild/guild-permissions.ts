import {GuildMemberDto, SelfGuildMemberDto} from '../../dtos/response/member.dto';
import {GuildDto} from '../../dtos/response/guild.dto';
import {hasPermission, parsePermissions, PermissionValue, Permissions} from '../../enums/permissions.enum';
import {
    modulePermissionFeatures,
    ModulePermissionValue,
    parseModulePermissions,
} from '../../enums/module-permissions.enum';
import {guildFeatures} from './guild-features';

/** Prefers the server's `effectivePermissions` (the mask every endpoint gates on); the union fallback cannot see ownership, since the owner's member row carries no permissions and their only role is @everyone. */
export function effectiveGuildPermissions(member: GuildMemberDto | null | undefined): PermissionValue {
    if (!member) return 0n;

    const resolved = (member as SelfGuildMemberDto).effectivePermissions;
    // Only an absent field falls through to the union; an explicit empty answer ("no permissions") must not be upgraded to it.
    if (resolved !== undefined && resolved !== null) return parsePermissions(resolved);

    return unionMemberPermissions(member);
}

/** Unions parsed masks, never concatenated wire strings: a mask can arrive as a JSON number, and one numeric source in a comma-joined string breaks the whole parse, silently dropping bits. */
export function unionMemberPermissions(member: GuildMemberDto | null | undefined): PermissionValue {
    if (!member) return 0n;

    return (member.roleMembers ?? []).reduce(
        (acc, {role}) => acc | parsePermissions(role.permissions),
        parsePermissions(member.permissions),
    );
}

/** What a member may do here, across both permission spaces. */
export interface GuildAbilities {
    readonly core: PermissionValue;
    readonly module: ModulePermissionValue;
    readonly isOwner: boolean;
    /** Owner, or Superadmin in the core mask. Satisfies any core or module check. */
    readonly isSuperadmin: boolean;

    can(permission: PermissionValue): boolean;

    canModule(permission: ModulePermissionValue): boolean;
}

/** Denies everything - what a caller holds before the member row arrives. */
export const NO_ABILITIES: GuildAbilities = {
    core: 0n,
    module: 0n,
    isOwner: false,
    isSuperadmin: false,
    can: () => false,
    canModule: () => false,
};

type AbilityGuild = Pick<GuildDto, 'ownerId' | 'features' | 'roles'>;

/** The only place module bits are resolved (the server sends no `effectiveModulePermissions`); inherits the ownership blind spot from {@link unionMemberPermissions}, which is why `isOwner` is folded in explicitly. */
export function guildAbilities(
    member: GuildMemberDto | null | undefined,
    guild: AbilityGuild | null | undefined,
    ownUserId: string | null | undefined,
): GuildAbilities {
    if (!member && !guild) return NO_ABILITIES;

    const core = effectiveGuildPermissions(member);
    const module = unionModulePermissions(member, guild);
    const isOwner = !!ownUserId && !!guild?.ownerId && ownUserId === guild.ownerId;
    const isSuperadmin = isOwner || hasPermission(core, Permissions.Superadmin);

    // A missing guild means "no context," not "no modules" - matching how the household components already treat it.
    const enabled = guild ? guildFeatures(guild) : null;

    return {
        core,
        module,
        isOwner,
        isSuperadmin,
        can: permission => isSuperadmin || hasPermission(core, permission),

        // The module clamp comes first: a disabled module resolves as unset for everybody, owner and Superadmin included.
        canModule: permission => {
            if (enabled && !modulePermissionFeatures(permission).every(f => enabled.has(f))) return false;
            return isSuperadmin || (module & permission) === permission;
        },
    };
}

/** Resolves roles via `guild.roles`, not `roleMembers[].role`: that nested shape carries only the core mask, so unioning it directly would find no module bits. */
export function unionModulePermissions(
    member: GuildMemberDto | null | undefined,
    guild: AbilityGuild | null | undefined,
): ModulePermissionValue {
    if (!member) return 0n;

    const byId = new Map((guild?.roles ?? []).map(role => [role.id, role]));

    return (member.roleMembers ?? []).reduce((acc, {role}) => {
        const full = byId.get(role?.id) ?? role;
        return acc | parseModulePermissions(full?.modulePermissions);
    }, parseModulePermissions(member.modulePermissions));
}

/** Owner first (`SelfGuildMemberDto.permissions` doesn't reliably carry Superadmin for them), else Superadmin or ManageGuild; a missing `member` means "not loaded" and fails closed, deliberately, until it arrives. */
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
