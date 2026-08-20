import {RoleDto, RoleType} from '../../../../../../../dtos/response/guild.dto';

/** The everyone role is the implicit one every member carries; it stays where it is in the hierarchy. */
export function isPinnedRole(role: RoleDto): boolean {
    return role.type === RoleType.Everyone;
}

/**
 * A move is legal when it neither picks up the pinned role nor steps over it: splicing a role
 * across the pinned one shifts that role's own index, which is the same thing by another route.
 */
export function canReorderRole(roles: readonly RoleDto[], fromIndex: number, targetIndex: number): boolean {
    if (fromIndex === targetIndex) return false;
    if (fromIndex < 0 || fromIndex >= roles.length) return false;
    if (targetIndex < 0 || targetIndex >= roles.length) return false;
    if (isPinnedRole(roles[fromIndex])) return false;

    const low = Math.min(fromIndex, targetIndex);
    const high = Math.max(fromIndex, targetIndex);
    return !roles.some((r, i) => i >= low && i <= high && i !== fromIndex && isPinnedRole(r));
}

/** Null when the move is illegal. Recomputes `position` for every role so the result can go straight to the API. */
export function reorderRoles(
    roles: readonly RoleDto[],
    fromIndex: number,
    targetIndex: number,
): RoleDto[] | null {
    if (!canReorderRole(roles, fromIndex, targetIndex)) return null;

    const next = [...roles];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(targetIndex, 0, moved);
    return next.map((r, i) => ({...r, position: i}));
}
