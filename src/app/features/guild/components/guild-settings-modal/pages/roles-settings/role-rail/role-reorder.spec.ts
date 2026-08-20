import {canReorderRole, isPinnedRole, reorderRoles} from './role-reorder';
import {RoleDto, RoleType} from '../../../../../../../dtos/response/guild.dto';

function role(id: string, position: number, type: RoleType = RoleType.None): RoleDto {
    return {id, name: id, type, color: '#fff', permissions: 'None', position} as RoleDto;
}

const ROLES = [role('narrator', 0), role('recruit', 1), role('everyone', 2, RoleType.Everyone)];

describe('isPinnedRole', () => {
    it('pins only the everyone role', () => {
        expect(isPinnedRole(ROLES[0])).toBe(false);
        expect(isPinnedRole(ROLES[2])).toBe(true);
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

    it('moves the role and recomputes every position', () => {
        const result = reorderRoles(ROLES, 0, 1);

        expect(result?.map(r => r.id)).toEqual(['recruit', 'narrator', 'everyone']);
        expect(result?.map(r => r.position)).toEqual([0, 1, 2]);
    });

    it('leaves the pinned role in place while others move around it', () => {
        const result = reorderRoles(ROLES, 1, 0);

        expect(result?.map(r => r.id)).toEqual(['recruit', 'narrator', 'everyone']);
    });
});
