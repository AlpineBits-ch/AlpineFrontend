import {effectiveGuildPermissions, guildAbilities, memberCanManageGuild, NO_ABILITIES} from './guild-permissions';
import {GuildMemberDto} from '../../dtos/response/member.dto';
import {GuildDto, RoleDto} from '../../dtos/response/guild.dto';
import {Permissions} from '../../enums/permissions.enum';
import {ModulePermissions} from '../../enums/module-permissions.enum';

const OWNER = 'user-owner';
const SOMEONE = 'user-someone';

type AbilityGuild = Pick<GuildDto, 'ownerId' | 'features' | 'roles'>;

function guild(roles: Partial<RoleDto>[], features = 'Wiki, Lists, Ledger'): AbilityGuild {
    return {ownerId: OWNER, features, roles: roles as RoleDto[]};
}

/** A member holding one role, in the shape the server actually sends: the nested role is flat. */
function memberWithRole(role: Partial<RoleDto>, own = ''): GuildMemberDto {
    return {
        permissions: own,
        roleMembers: [{role: {id: role.id, permissions: role.permissions ?? 'None'} as RoleDto}],
    } as GuildMemberDto;
}

function member(basePermissions: string, rolePermissions: string[] = []): GuildMemberDto {
    return {
        permissions: basePermissions,
        roleMembers: rolePermissions.map(permissions => ({role: {permissions}})),
    } as GuildMemberDto;
}

describe('effectiveGuildPermissions', () => {
    it('unions the member bits with every role they hold', () => {
        const perms = effectiveGuildPermissions(member('ViewChannel', ['SendMessages', 'ManageGuild']));

        expect(perms & Permissions.ViewChannel).toBe(Permissions.ViewChannel);
        expect(perms & Permissions.SendMessages).toBe(Permissions.SendMessages);
        expect(perms & Permissions.ManageGuild).toBe(Permissions.ManageGuild);
    });

    it('falls back to the member bits when roles are absent', () => {
        const bare = {permissions: 'ViewChannel'} as GuildMemberDto;

        expect(effectiveGuildPermissions(bare) & Permissions.ViewChannel).toBe(Permissions.ViewChannel);
    });

    it('grants nothing for a member that has not loaded', () => {
        expect(effectiveGuildPermissions(null)).toBe(0n);
    });

    // The server's own answer wins where it exists. It is the mask every endpoint gates on, and
    // unlike the union below it can see ownership - the whole reason the field was added.
    it('prefers the server-resolved mask over the role union', () => {
        const withResolved = {
            permissions: '',
            roleMembers: [{role: {permissions: 'ViewChannel'}}],
            effectivePermissions: 'Superadmin',
        } as unknown as GuildMemberDto;

        expect(effectiveGuildPermissions(withResolved) & Permissions.Superadmin)
            .toBe(Permissions.Superadmin);
    });

    // "None" is what the server sends for a member with nothing, and it must not be mistaken for
    // "field absent" and quietly replaced by a union that would report more.
    it('honours an explicit empty answer rather than falling back', () => {
        const denied = {
            permissions: 'ManageGuild',
            roleMembers: [{role: {permissions: 'Superadmin'}}],
            effectivePermissions: 'None',
        } as unknown as GuildMemberDto;

        expect(effectiveGuildPermissions(denied)).toBe(0n);
    });

    // The reported crash: the server sends the resolved mask as a JSON number, not a name list,
    // and every string method in parsePermissions threw on it -
    // "TypeError: serialized.replace is not a function" out of a permission-gated computed.
    it('reads a server-resolved mask that arrives as a number', () => {
        const numeric = {
            permissions: '',
            roleMembers: [],
            effectivePermissions: Number(Permissions.ManageGuild),
        } as unknown as GuildMemberDto;

        expect(effectiveGuildPermissions(numeric) & Permissions.ManageGuild)
            .toBe(Permissions.ManageGuild);
    });

    it('unions a numeric member mask with the named roles it holds', () => {
        const mixed = {
            permissions: Number(Permissions.ViewChannel),
            roleMembers: [{role: {permissions: 'ManageGuild'}}],
        } as unknown as GuildMemberDto;
        const perms = effectiveGuildPermissions(mixed);

        expect(perms & Permissions.ViewChannel).toBe(Permissions.ViewChannel);
        expect(perms & Permissions.ManageGuild).toBe(Permissions.ManageGuild);
    });

    it('falls back to the union when the server has not shipped the field', () => {
        const legacy = member('ViewChannel', ['ManageGuild']);

        expect(effectiveGuildPermissions(legacy) & Permissions.ManageGuild)
            .toBe(Permissions.ManageGuild);
    });
});

describe('guildAbilities module resolution', () => {
    const role = {id: 'role-1', permissions: 'ViewChannel', modulePermissions: 'AddListItems, ViewWiki'};

    // The flat role nested under roleMembers carries the core mask only, so the module half has
    // to come from guild.roles or it is silently zero everywhere.
    it('resolves module bits through guild.roles, not the nested role', () => {
        const abilities = guildAbilities(memberWithRole(role), guild([role]), SOMEONE);

        expect(abilities.canModule(ModulePermissions.AddListItems)).toBe(true);
        expect(abilities.canModule(ModulePermissions.ViewWiki)).toBe(true);
    });

    it('withholds a module bit the member does not hold', () => {
        const abilities = guildAbilities(memberWithRole(role), guild([role]), SOMEONE);

        expect(abilities.canModule(ModulePermissions.ManageLedger)).toBe(false);
    });

    it('unions the member own module bits with their roles', () => {
        const member = {
            permissions: 'None',
            modulePermissions: 'ManageLedger',
            roleMembers: [{role: {id: role.id, permissions: 'None'} as RoleDto}],
        } as GuildMemberDto;
        const abilities = guildAbilities(member, guild([role]), SOMEONE);

        expect(abilities.canModule(ModulePermissions.ManageLedger)).toBe(true);
        expect(abilities.canModule(ModulePermissions.AddListItems)).toBe(true);
    });

    it('grants module bits to Superadmin, which has no bit of its own over here', () => {
        const admin = {permissions: 'Superadmin', roleMembers: []} as unknown as GuildMemberDto;

        expect(guildAbilities(admin, guild([]), SOMEONE).canModule(ModulePermissions.ManageLedger)).toBe(true);
    });

    it('grants module bits to the owner, whose member row carries nothing', () => {
        const bare = {permissions: 'None', roleMembers: []} as unknown as GuildMemberDto;

        expect(guildAbilities(bare, guild([]), OWNER).canModule(ModulePermissions.ManageLedger)).toBe(true);
    });

    // A module switched off is clamped out for everyone. "This house doesn't do money" is not a
    // permission problem and Superadmin is not an answer to it.
    it('clamps a disabled module even for Superadmin', () => {
        const admin = {permissions: 'Superadmin', roleMembers: []} as unknown as GuildMemberDto;
        const noLedger = guild([], 'Wiki, Lists');

        expect(guildAbilities(admin, noLedger, SOMEONE).canModule(ModulePermissions.ManageLedger)).toBe(false);
    });

    it('clamps a disabled module even for the owner', () => {
        const bare = {permissions: 'None', roleMembers: []} as unknown as GuildMemberDto;
        const noLedger = guild([], 'Wiki, Lists');

        expect(guildAbilities(bare, noLedger, OWNER).canModule(ModulePermissions.ManageLedger)).toBe(false);
    });

    it('does not clamp when no guild was supplied', () => {
        const solo = {permissions: 'None', modulePermissions: 'ManageLedger', roleMembers: []} as unknown as GuildMemberDto;

        expect(guildAbilities(solo, null, SOMEONE).canModule(ModulePermissions.ManageLedger)).toBe(true);
    });
});

describe('guildAbilities core', () => {
    it('answers core checks off the resolved mask', () => {
        const abilities = guildAbilities(member('ViewChannel', ['ManageGuild']), guild([]), SOMEONE);

        expect(abilities.can(Permissions.ManageGuild)).toBe(true);
        expect(abilities.can(Permissions.BanMembers)).toBe(false);
    });

    it('lets Superadmin satisfy any core check', () => {
        const abilities = guildAbilities(member('Superadmin'), guild([]), SOMEONE);

        expect(abilities.can(Permissions.BanMembers)).toBe(true);
    });

    it('reports the owner as such even with an empty member row', () => {
        const abilities = guildAbilities(member('None'), guild([]), OWNER);

        expect(abilities.isOwner).toBe(true);
        expect(abilities.isSuperadmin).toBe(true);
    });

    it('fails closed before anything has loaded', () => {
        const abilities = guildAbilities(null, null, SOMEONE);

        expect(abilities.can(Permissions.ViewChannel)).toBe(false);
        expect(abilities.canModule(ModulePermissions.ViewWiki)).toBe(false);
    });

    it('denies everything through NO_ABILITIES', () => {
        expect(NO_ABILITIES.can(Permissions.ViewChannel)).toBe(false);
        expect(NO_ABILITIES.canModule(ModulePermissions.ViewWiki)).toBe(false);
        expect(NO_ABILITIES.isSuperadmin).toBe(false);
    });
});

describe('memberCanManageGuild', () => {
    it('lets the owner in without consulting permissions', () => {
        // Owners are the reason for the short-circuit: their member row does not
        // reliably carry Superadmin.
        expect(memberCanManageGuild(member('None'), OWNER, OWNER)).toBe(true);
        expect(memberCanManageGuild(null, OWNER, OWNER)).toBe(true);
    });

    it('lets a member in on ManageGuild held through a role', () => {
        expect(memberCanManageGuild(member('ViewChannel', ['ManageGuild']), OWNER, SOMEONE)).toBe(true);
    });

    it('lets a member in on Superadmin', () => {
        expect(memberCanManageGuild(member('Superadmin'), OWNER, SOMEONE)).toBe(true);
    });

    /** The reported bug: an ordinary member could open server settings. */
    it('keeps an ordinary member out', () => {
        const ordinary = member('ViewChannel', ['SendMessages', 'AddReactions']);

        expect(memberCanManageGuild(ordinary, OWNER, SOMEONE)).toBe(false);
    });

    it('fails closed while the member row is still loading', () => {
        expect(memberCanManageGuild(null, OWNER, SOMEONE)).toBe(false);
    });

    it('fails closed when the viewer is unknown', () => {
        expect(memberCanManageGuild(null, OWNER, undefined)).toBe(false);
    });
});
