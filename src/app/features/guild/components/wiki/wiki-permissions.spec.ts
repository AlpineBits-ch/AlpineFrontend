import {Permissions} from '../../../../enums/permissions.enum';
import {canEditPage, wikiAbilities} from './wiki-permissions';

describe('wikiAbilities', () => {
    it('grants nothing for no permissions', () => {
        expect(wikiAbilities(0n)).toEqual({
            canCreate: false,
            canEditAny: false,
            canEditOwn: false,
            canDelete: false,
            canManageStructure: false,
            canManageRevisions: false,
        });
    });

    it('maps each wiki permission to its ability', () => {
        expect(wikiAbilities(Permissions.CreateWikiPages).canCreate).toBe(true);
        expect(wikiAbilities(Permissions.EditAnyWikiPage).canEditAny).toBe(true);
        expect(wikiAbilities(Permissions.EditOwnWikiPages).canEditOwn).toBe(true);
        expect(wikiAbilities(Permissions.DeleteWikiPages).canDelete).toBe(true);
        expect(wikiAbilities(Permissions.ManageWikiStructure).canManageStructure).toBe(true);
        expect(wikiAbilities(Permissions.ManageWikiRevisions).canManageRevisions).toBe(true);
    });

    it('grants everything to Superadmin', () => {
        const abilities = wikiAbilities(Permissions.Superadmin);
        expect(Object.values(abilities).every(Boolean)).toBe(true);
    });

    it('does not leak one wiki permission into another', () => {
        expect(wikiAbilities(Permissions.CreateWikiPages).canDelete).toBe(false);
    });
});

describe('canEditPage', () => {
    const none = wikiAbilities(0n);
    const own = wikiAbilities(Permissions.EditOwnWikiPages);
    const any = wikiAbilities(Permissions.EditAnyWikiPage);

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

    // Not-yet-loaded identity must fail closed, matching memberCanManageGuild: a control is
    // never briefly offered to somebody who turns out not to hold the permission.
    it('denies own-page editing while the own user id is still unknown', () => {
        expect(canEditPage(own, 'u1', null)).toBe(false);
    });
});
