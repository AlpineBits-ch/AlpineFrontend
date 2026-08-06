import {describe, expect, it} from 'vitest';
import {GuildDto, RoleDto, RoleType} from '../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../dtos/response/member.dto';
import {defaultRotationRoleId, findFlatmatesRole, isFlatmate} from './household-roles';

function role(overrides: Partial<RoleDto> = {}): RoleDto {
    return {
        id: 'role_flatmates',
        name: 'Flatmates',
        type: RoleType.None,
        position: 1,
        ...overrides,
    } as RoleDto;
}

function guild(roles: RoleDto[]): GuildDto {
    return {id: 'gild_1', roles} as GuildDto;
}

function member(roleIds: string[]): GuildMemberDto {
    return {
        userId: 'user_ben',
        roleMembers: roleIds.map(id => ({role: role({id})})),
    } as GuildMemberDto;
}

const everyone = role({id: 'role_everyone', name: 'Flatmates', type: RoleType.Everyone, position: 0});

describe('findFlatmatesRole', () => {
    it('finds the seeded role', () => {
        expect(findFlatmatesRole(guild([role()]))?.id).toBe('role_flatmates');
    });

    it('matches case-insensitively and ignores surrounding whitespace', () => {
        expect(findFlatmatesRole(guild([role({name: ' flatmates '})]))?.id).toBe('role_flatmates');
    });

    it('never matches @everyone, whatever it happens to be called', () => {
        // @everyone is every member, so mistaking it for the rota pool would put a guest on the
        // bins - the exact distinction this role exists to draw.
        expect(findFlatmatesRole(guild([everyone]))).toBeUndefined();
    });

    it('is undefined in a guild that has no such role, rather than guessing at another', () => {
        expect(findFlatmatesRole(guild([role({id: 'role_mods', name: 'Moderators'})]))).toBeUndefined();
    });

    it('is undefined for a missing guild', () => {
        expect(findFlatmatesRole(null)).toBeUndefined();
    });
});

describe('defaultRotationRoleId', () => {
    it('offers the Flatmates role, which is what makes a new chore one press', () => {
        expect(defaultRotationRoleId(guild([role()]))).toBe('role_flatmates');
    });

    it('offers nothing rather than whichever role happened to sort first', () => {
        expect(defaultRotationRoleId(guild([role({id: 'role_mods', name: 'Moderators'})]))).toBeNull();
    });
});

describe('isFlatmate', () => {
    it('is true for somebody holding the role', () => {
        expect(isFlatmate(guild([role()]), member(['role_flatmates']))).toBe(true);
    });

    it('is false for a guest, who holds only @everyone', () => {
        expect(isFlatmate(guild([role()]), member(['role_everyone']))).toBe(false);
    });

    it('is false when the house has no Flatmates role - not "everyone is a guest"', () => {
        // Callers pair this with a findFlatmatesRole check before drawing a guest badge, because
        // a renamed role must not relabel the whole house.
        expect(isFlatmate(guild([]), member(['role_flatmates']))).toBe(false);
    });

    it('is false for a member with no roles at all', () => {
        expect(isFlatmate(guild([role()]), member([]))).toBe(false);
    });
});
