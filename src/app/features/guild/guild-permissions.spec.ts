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
