import {effectiveGuildPermissions, memberCanManageGuild} from './guild-permissions';
import {GuildMemberDto} from '../../dtos/response/member.dto';
import {Permissions} from '../../enums/permissions.enum';

const OWNER = 'user-owner';
const SOMEONE = 'user-someone';

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
