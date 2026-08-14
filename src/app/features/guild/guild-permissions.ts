import {GuildMemberDto, SelfGuildMemberDto} from '../../dtos/response/member.dto';
import {GuildDto} from '../../dtos/response/guild.dto';
import {hasPermission, parsePermissions, PermissionValue, Permissions} from '../../enums/permissions.enum';
import {
    modulePermissionFeatures,
    ModulePermissionValue,
    parseModulePermissions,
} from '../../enums/module-permissions.enum';
import {guildFeatures} from './guild-features';

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

    return unionMemberPermissions(member);
}

/**
 * The member's own bits unioned with every role they hold - the pre-`effectivePermissions` answer,
 * and still the only one available to a caller holding a plain `GuildMemberDto`. Blind to
 * ownership, exactly as described above.
 *
 * <p>Unions the parsed masks rather than concatenating the wire strings first, which is what half a
 * dozen call sites used to hand-roll. A mask can arrive as a JSON number (see
 * `SerializedPermissions`), and one numeric source in a comma-joined string turns the whole join
 * into an unparseable name list - the member's own bits, or every role's, silently dropped.</p>
 */
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

/**
 * Resolves one member's permissions against one guild.
 *
 * <p>Replaces the owner/Superadmin/`can` triple that seven household components each hand-rolled,
 * and is the only place module bits are resolved: the server sends no `effectiveModulePermissions`
 * to prefer, so that half is unioned here and inherits the ownership blind spot described on
 * {@link unionMemberPermissions} - which is why `isOwner` is folded in explicitly.</p>
 */
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

    // A guild we were not given is "no context" rather than "no modules", matching how the
    // household components treat a missing guild today.
    const enabled = guild ? guildFeatures(guild) : null;

    return {
        core,
        module,
        isOwner,
        isSuperadmin,
        can: permission => isSuperadmin || hasPermission(core, permission),

        // The module clamp comes first on purpose: a disabled module resolves as unset for
        // everybody, owner and Superadmin included.
        canModule: permission => {
            if (enabled && !modulePermissionFeatures(permission).every(f => enabled.has(f))) return false;
            return isSuperadmin || (module & permission) === permission;
        },
    };
}

/**
 * The member's module bits unioned with every role they hold.
 *
 * <p>Roles are resolved out of `guild.roles` rather than read off `roleMembers[].role`: that
 * nested shape carries the core mask only, so unioning it directly would find no module bits at
 * all.</p>
 */
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
