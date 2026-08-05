import {hasPermission, Permissions, PermissionValue} from '../../../../enums/permissions.enum';

/**
 * What the current member may do in this wiki.
 *
 * The nine wiki permissions have existed in the enum since the feature shipped and were never
 * read by the UI - every member saw Edit and Delete. This is where that is fixed.
 */
export interface WikiAbilities {
    canCreate: boolean;
    canEditAny: boolean;
    canEditOwn: boolean;
    canDelete: boolean;
    canManageStructure: boolean;
    canManageRevisions: boolean;
}

/**
 * `isOwner` is a separate argument rather than something derived from `perms` because the guild
 * owner's own member record does not reliably carry Superadmin - the same caveat
 * `memberCanManageGuild` documents. Without it the owner of a guild whose roles happen not to
 * name the wiki bits gets a wiki they can read and never edit.
 */
export function wikiAbilities(perms: PermissionValue, isOwner = false): WikiAbilities {
    const superadmin = isOwner || hasPermission(perms, Permissions.Superadmin);
    const granted = (permission: PermissionValue) => superadmin || hasPermission(perms, permission);
    return {
        canCreate: granted(Permissions.CreateWikiPages),
        canEditAny: granted(Permissions.EditAnyWikiPage),
        canEditOwn: granted(Permissions.EditOwnWikiPages),
        canDelete: granted(Permissions.DeleteWikiPages),
        canManageStructure: granted(Permissions.ManageWikiStructure),
        canManageRevisions: granted(Permissions.ManageWikiRevisions),
    };
}

/**
 * A null `ownUserId` means "identity not loaded yet", not "not the author", and is denied.
 * Failing closed while loading is deliberate - see the note on `memberCanManageGuild`.
 */
export function canEditPage(
    abilities: WikiAbilities,
    authorId: string,
    ownUserId: string | null,
): boolean {
    if (abilities.canEditAny) return true;
    return abilities.canEditOwn && ownUserId !== null && ownUserId === authorId;
}
