import {ModulePermissions} from '../../../../enums/module-permissions.enum';
import {GuildAbilities} from '../../guild-permissions';

/**
 * What the current member may do in this wiki.
 */
export interface WikiAbilities {
    canCreate: boolean;
    canEditAny: boolean;
    canEditOwn: boolean;
    canDelete: boolean;
    canManageStructure: boolean;
    canManageRevisions: boolean;
}

/** Reads the module mask; `canModule` already folds in ownership, Superadmin, and the clamp for a guild with the wiki module switched off. */
export function wikiAbilities(abilities: GuildAbilities): WikiAbilities {
    return {
        canCreate: abilities.canModule(ModulePermissions.CreateWikiPages),
        canEditAny: abilities.canModule(ModulePermissions.EditAnyWikiPage),
        canEditOwn: abilities.canModule(ModulePermissions.EditOwnWikiPages),
        canDelete: abilities.canModule(ModulePermissions.DeleteWikiPages),
        canManageStructure: abilities.canModule(ModulePermissions.ManageWikiStructure),
        canManageRevisions: abilities.canModule(ModulePermissions.ManageWikiRevisions),
    };
}

/** A null `ownUserId` means "identity not loaded yet", not "not the author", and is denied; failing closed while loading is deliberate (see the note on `memberCanManageGuild`). */
export function canEditPage(
    abilities: WikiAbilities,
    authorId: string,
    ownUserId: string | null,
): boolean {
    if (abilities.canEditAny) return true;
    return abilities.canEditOwn && ownUserId !== null && ownUserId === authorId;
}
