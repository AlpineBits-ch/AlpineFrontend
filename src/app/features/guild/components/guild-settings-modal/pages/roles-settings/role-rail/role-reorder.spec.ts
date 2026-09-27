import {
    canReorderRole,
    changedRolePositions,
    insertCreatedRole,
    isPinnedRole,
    reorderRoles,
    sortRolesByRank,
} from './role-reorder';
import {RoleDto, RoleType} from '../../../../../../../dtos/response/guild.dto';

function role(id: string, position: number, type: RoleType = RoleType.None): RoleDto {
    return {id, name: id, type, color: '#fff', permissions: 'None', position} as RoleDto;
}

const ROLES = [role('narrator', 2), role('recruit', 1), role('everyone', 0, RoleType.Everyone)];

describe('isPinnedRole', () => {
    it('pins only the everyone role', () => {
        expect(isPinnedRole(ROLES[0])).toBe(false);
        expect(isPinnedRole(ROLES[2])).toBe(true);
    });
});

describe('sortRolesByRank', () => {
    it('puts the highest position first and everyone last', () => {
        const sorted = sortRolesByRank([ROLES[2], ROLES[1], ROLES[0]]);

        expect(sorted.map(r => r.id)).toEqual(['narrator', 'recruit', 'everyone']);
    });
});

describe('canReorderRole', () => {
    it('rejects moving to the same index', () => {
        expect(canReorderRole(ROLES, 0, 0)).toBe(false);
    });

    it('rejects an out-of-bounds index', () => {
        expect(canReorderRole(ROLES, 0, 5)).toBe(false);
        expect(canReorderRole(ROLES, -1, 1)).toBe(false);
    });

    it('rejects picking up the pinned role', () => {
        expect(canReorderRole(ROLES, 2, 0)).toBe(false);
    });

    it('rejects stepping another role over the pinned one', () => {
        expect(canReorderRole(ROLES, 0, 2)).toBe(false);
    });

    it('allows a move that does not touch the pinned role', () => {
        expect(canReorderRole(ROLES, 0, 1)).toBe(true);
    });
});

describe('reorderRoles', () => {
    it('returns null for an illegal move', () => {
        expect(reorderRoles(ROLES, 2, 0)).toBeNull();
    });

    it('moves the role and counts positions down to everyone at 0', () => {
        const result = reorderRoles(ROLES, 0, 1);

        expect(result?.map(r => r.id)).toEqual(['recruit', 'narrator', 'everyone']);
        expect(result?.map(r => r.position)).toEqual([2, 1, 0]);
    });
});

describe('changedRolePositions', () => {
    it('sends only moved roles, never everyone, and never a position below 1', () => {
        const next = reorderRoles(ROLES, 1, 0)!;
        const body = changedRolePositions(ROLES, next);

        expect(body).toEqual([
            {roleId: 'recruit', position: 2},
            {roleId: 'narrator', position: 1},
        ]);
    });

    it('closes gaps left by a deleted role', () => {
        const gappy = [role('a', 5), role('b', 3), role('c', 1), role('everyone', 0, RoleType.Everyone)];
        const body = changedRolePositions(gappy, reorderRoles(gappy, 2, 1)!);

        expect(body.every(p => p.position >= 1)).toBe(true);
        expect(new Set(body.map(p => p.position)).size).toBe(body.length);
    });
});

describe('insertCreatedRole', () => {
    it('places the new role just above everyone and shifts the rest up', () => {
        const result = insertCreatedRole(ROLES, role('fresh', 1));

        expect(result.map(r => [r.id, r.position])).toEqual([
            ['narrator', 3],
            ['recruit', 2],
            ['fresh', 1],
            ['everyone', 0],
        ]);
    });
});
