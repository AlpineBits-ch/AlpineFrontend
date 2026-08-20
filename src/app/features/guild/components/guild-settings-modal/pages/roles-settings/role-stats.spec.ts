import {countRoleOverrides, countVisibleChannels} from './role-stats';
import {
    ChannelDto,
    ChannelPermission,
    ChannelType,
    RoleDto,
    RoleType,
} from '../../../../../../dtos/response/guild.dto';

const ROLE_ID = 'role_1';

function role(permissions: string): RoleDto {
    return {
        id: ROLE_ID,
        name: 'recruit',
        type: RoleType.None,
        color: '#fff',
        permissions,
        position: 1,
    } as RoleDto;
}

function channel(id: string, override?: Partial<ChannelPermission>): ChannelDto {
    const permissions: ChannelPermission[] = override
        ? [
              {
                  id: 'p_' + id,
                  roleId: ROLE_ID,
                  memberId: undefined,
                  channelId: id,
                  categoryId: undefined,
                  allowPermissions: 'None',
                  denyPermissions: 'None',
                  ...override,
              } as ChannelPermission,
          ]
        : [];
    return {
        id,
        name: id,
        type: ChannelType.Text,
        categoryId: undefined,
        permissions,
        position: 0,
    } as ChannelDto;
}

describe('countRoleOverrides', () => {
    it('counts only channels carrying an override for this role', () => {
        const channels = [
            channel('a'),
            channel('b', {roleId: ROLE_ID}),
            channel('c', {roleId: 'other_role'}),
        ];

        expect(countRoleOverrides(role('None'), channels)).toBe(1);
    });
});

describe('countVisibleChannels', () => {
    it('falls back to the role base permission when there is no override', () => {
        const channels = [channel('a'), channel('b')];

        expect(countVisibleChannels(role('ViewChannel'), channels)).toBe(2);
        expect(countVisibleChannels(role('None'), channels)).toBe(0);
    });

    it('a channel-level deny turns visibility off even when the base permission grants it', () => {
        const channels = [channel('a', {denyPermissions: 'ViewChannel'})];

        expect(countVisibleChannels(role('ViewChannel'), channels)).toBe(0);
    });

    it('a channel-level allow turns visibility on even when the base permission does not grant it', () => {
        const channels = [channel('a', {allowPermissions: 'ViewChannel'})];

        expect(countVisibleChannels(role('None'), channels)).toBe(1);
    });

    it('an override for a different key falls back to the base permission', () => {
        const channels = [channel('a', {allowPermissions: 'SendMessages'})];

        expect(countVisibleChannels(role('ViewChannel'), channels)).toBe(1);
        expect(countVisibleChannels(role('None'), channels)).toBe(0);
    });
});
