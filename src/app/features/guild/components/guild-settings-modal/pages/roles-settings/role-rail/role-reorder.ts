import {RoleDto, RoleType} from '../../../../../../../dtos/response/guild.dto';
import {RolePositionDto} from '../../../../../../../dtos/request/reorder-roles.dto';

/** The everyone role is the implicit one every member carries; it stays where it is in the hierarchy. */
export function isPinnedRole(role: RoleDto): boolean {
    return role.type === RoleType.Everyone;
}

/** Highest rank first, so the pinned everyone role (position 0) sits at the bottom. */
export function sortRolesByRank(roles: readonly RoleDto[]): RoleDto[] {
    return [...roles].sort((a, b) => b.position - a.position);
}

/** Mirrors the server's create: the new role takes position 1 and everything from 1 up moves one higher. */
export function insertCreatedRole(roles: readonly RoleDto[], created: RoleDto): RoleDto[] {
    const shifted = roles.map(r => (r.position >= created.position ? {...r, position: r.position + 1} : r));
    return sortRolesByRank([...shifted, created]);
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

/** Null when the move is illegal. Positions count down from the top so the bottom row lands on 0. */
export function reorderRoles(
    roles: readonly RoleDto[],
    fromIndex: number,
    targetIndex: number,
): RoleDto[] | null {
    if (!canReorderRole(roles, fromIndex, targetIndex)) return null;

    const next = [...roles];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(targetIndex, 0, moved);
    return next.map((r, i) => ({...r, position: next.length - 1 - i}));
}

/** The request body: only roles whose position changed, never the pinned one. */
export function changedRolePositions(
    previous: readonly RoleDto[],
    next: readonly RoleDto[],
): RolePositionDto[] {
    const before = new Map(previous.map(r => [r.id, r.position]));
    return next
        .filter(r => !isPinnedRole(r) && before.get(r.id) !== r.position)
        .map(r => ({roleId: r.id, position: r.position}));
}
