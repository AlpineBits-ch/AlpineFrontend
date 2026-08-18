import {ModulePermissions} from '../../../../enums/module-permissions.enum';
import {Permissions} from '../../../../enums/permissions.enum';
import {guildAbilities, NO_ABILITIES} from '../../guild-permissions';
import {GuildDto, RoleDto} from '../../../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../../../dtos/response/member.dto';
import {canEditPage, wikiAbilities} from './wiki-permissions';

const OWNER = 'user-owner';
const SOMEONE = 'user-someone';
const ROLE = 'role-1';

/** The wiki module on, so nothing below is failing for the clamp rather than the bit under test. */
function guild(modulePermissions: string): Pick<GuildDto, 'ownerId' | 'features' | 'roles'> {
    return {
        ownerId: OWNER,
        features: 'Wiki',
        roles: [{id: ROLE, permissions: 'None', modulePermissions} as RoleDto],
    };
}

function member(corePermissions = 'None'): GuildMemberDto {
    return {
        permissions: corePermissions,
        roleMembers: [{role: {id: ROLE, permissions: 'None'} as RoleDto}],
    } as GuildMemberDto;
}

function abilitiesFor(modulePermissions: string, core = 'None', viewer = SOMEONE) {
    return wikiAbilities(guildAbilities(member(core), guild(modulePermissions), viewer));
}

describe('wikiAbilities', () => {
    it('grants nothing for no permissions', () => {
        expect(abilitiesFor('None')).toEqual({
            canCreate: false,
            canEditAny: false,
            canEditOwn: false,
            canDelete: false,
            canManageStructure: false,
            canManageRevisions: false,
            canPublish: false,
        });
    });

    it('maps each wiki permission to its ability', () => {
        expect(abilitiesFor('CreateWikiPages').canCreate).toBe(true);
        expect(abilitiesFor('EditAnyWikiPage').canEditAny).toBe(true);
        expect(abilitiesFor('EditOwnWikiPages').canEditOwn).toBe(true);
        expect(abilitiesFor('DeleteWikiPages').canDelete).toBe(true);
        expect(abilitiesFor('ManageWikiStructure').canManageStructure).toBe(true);
        expect(abilitiesFor('ManageWikiRevisions').canManageRevisions).toBe(true);
        expect(abilitiesFor('PublishWikiPublicly').canPublish).toBe(true);
    });

    // Superadmin has no bit in the module space; it is read off the core mask instead.
    it('grants everything to Superadmin', () => {
        expect(Object.values(abilitiesFor('None', 'Superadmin')).every(Boolean)).toBe(true);
    });

    it('does not leak one wiki permission into another', () => {
        expect(abilitiesFor('CreateWikiPages').canDelete).toBe(false);
    });

    // Owner access must not depend on role bits: the owner's member record doesn't reliably carry Superadmin.
    it('grants everything to the guild owner regardless of their bits', () => {
        expect(Object.values(abilitiesFor('None', 'None', OWNER)).every(Boolean)).toBe(true);
    });

    it('treats a non-owner with no bits as before', () => {
        expect(abilitiesFor('None').canEditAny).toBe(false);
    });

    // A guild without the wiki module resolves these bits as unset for everybody.
    it('grants nothing when the wiki module is off, even to the owner', () => {
        const noWiki = {ownerId: OWNER, features: 'Lists', roles: [] as RoleDto[]};
        const abilities = wikiAbilities(guildAbilities(member('Superadmin'), noWiki, OWNER));

        expect(Object.values(abilities).some(Boolean)).toBe(false);
    });

    it('grants nothing before anything has loaded', () => {
        expect(Object.values(wikiAbilities(NO_ABILITIES)).some(Boolean)).toBe(false);
    });

    it('reads the module mask, not the core one', () => {
        // Bit 0 is ViewWiki over there and ViewChannel here; a core mask must not answer for it.
        const coreOnly = wikiAbilities(guildAbilities(member('ViewChannel'), guild('None'), SOMEONE));

        expect(coreOnly.canCreate).toBe(false);
        expect(Permissions.ViewChannel).toBe(ModulePermissions.ViewWiki);
    });
});

describe('canEditPage', () => {
    const none = abilitiesFor('None');
    const own = abilitiesFor('EditOwnWikiPages');
    const any = abilitiesFor('EditAnyWikiPage');

    it('lets an author edit their own page with EditOwnWikiPages', () => {
        expect(canEditPage(own, 'u1', 'u1')).toBe(true);
    });

    it('does not let EditOwnWikiPages edit somebody else', () => {
        expect(canEditPage(own, 'u2', 'u1')).toBe(false);
    });

    it('lets EditAnyWikiPage edit somebody else', () => {
        expect(canEditPage(any, 'u2', 'u1')).toBe(true);
    });

    it('denies everything with no edit permission at all', () => {
        expect(canEditPage(none, 'u1', 'u1')).toBe(false);
    });

    // Not-yet-loaded identity must fail closed, matching memberCanManageGuild.
    it('denies own-page editing while the own user id is still unknown', () => {
        expect(canEditPage(own, 'u1', null)).toBe(false);
    });
});
