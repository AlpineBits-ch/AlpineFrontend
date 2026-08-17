import {RoleDto, RoleType} from '../../dtos/response/guild.dto';

/**
 * Reading the role fields the server added for display, each with the default that applies when
 * an older backend leaves the field out.
 */

/** Absent means mentionable - the server's own default. Only an explicit `false` withholds it. */
export function isRoleMentionable(role: Pick<RoleDto, 'mentionable'>): boolean {
    return role.mentionable !== false;
}

/** Absent means not hoisted, so a guild that predates the field keeps one flat member list. */
export function isRoleHoisted(role: Pick<RoleDto, 'hoist'>): boolean {
    return role.hoist === true;
}

/** Integration-owned. The server refuses every edit and delete with a 400, so the UI must too. */
export function isRoleManaged(role: Pick<RoleDto, 'isManaged'>): boolean {
    return role.isManaged === true;
}

export function isEveryoneRole(role: Pick<RoleDto, 'type'>): boolean {
    return role.type === RoleType.Everyone;
}

/** @everyone owns position 0 and nothing else may hold it; a managed role's position is fixed since the reorder endpoint refuses to be told about it. */
export function isRoleReorderable(role: Pick<RoleDto, 'type' | 'isManaged'>): boolean {
    return !isEveryoneRole(role) && !isRoleManaged(role);
}
