import {diffOverrides, isSyncedWithCategory} from './permission-sync';
import {ChannelPermission} from '../../../dtos/response/guild.dto';

function perm(over: Partial<ChannelPermission>): ChannelPermission {
    return {
        id: 'p',
        roleId: undefined,
        memberId: undefined,
        allowPermissions: 'None',
        denyPermissions: 'None',
        ...over,
    } as ChannelPermission;
}

describe('permission sync', () => {
    it('calls an empty pair synced', () => {
        expect(isSyncedWithCategory([], [])).toBe(true);
    });

    it('calls identical sets synced', () => {
        const rows = [perm({roleId: 'r1', allowPermissions: 'SendMessages'})];

        expect(isSyncedWithCategory(rows, rows)).toBe(true);
    });

    it('is not synced when a mask differs', () => {
        expect(
            isSyncedWithCategory(
                [perm({roleId: 'r1', allowPermissions: 'SendMessages'})],
                [perm({roleId: 'r1', allowPermissions: 'AddReactions'})],
            ),
        ).toBe(false);
    });

    it('names a channel-only override as removed by a sync', () => {
        const diff = diffOverrides([perm({roleId: 'r1'})], []);

        expect(diff).toEqual([{targetId: 'r1', kind: 'role', change: 'removed'}]);
    });

    it('names a category-only override as added by a sync', () => {
        const diff = diffOverrides([], [perm({memberId: 'm1'})]);

        expect(diff).toEqual([{targetId: 'm1', kind: 'member', change: 'added'}]);
    });

    it('names a differing mask as changed', () => {
        const diff = diffOverrides(
            [perm({roleId: 'r1', denyPermissions: 'SendMessages'})],
            [perm({roleId: 'r1', denyPermissions: 'None'})],
        );

        expect(diff).toEqual([{targetId: 'r1', kind: 'role', change: 'changed'}]);
    });

    it('compares the module masks too', () => {
        const diff = diffOverrides(
            [perm({roleId: 'r1', allowModulePermissions: 'ViewWiki'})],
            [perm({roleId: 'r1', allowModulePermissions: 'None'})],
        );

        expect(diff[0].change).toBe('changed');
    });
});
