import {GuildDto, RoleDto, RoleType} from '../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../dtos/response/member.dto';

/** Matched by name only (the client is never told the seeded role's id): a miss means "no default to offer", never "this person is a guest" - nothing is denied on the strength of it. */
export const FLATMATES_ROLE_NAME = 'Flatmates';

/** The seeded Flatmates role, or undefined in a guild that has none (or renamed it). */
export function findFlatmatesRole(guild: GuildDto | null | undefined): RoleDto | undefined {
    return (guild?.roles ?? []).find(role =>
        role.type !== RoleType.Everyone
        && role.name.trim().toLowerCase() === FLATMATES_ROLE_NAME.toLowerCase());
}

/** The role a new chore's rotation should default to; without it every new chore starts on an empty pool picker. */
export function defaultRotationRoleId(guild: GuildDto | null | undefined): string | null {
    return findFlatmatesRole(guild)?.id ?? null;
}

/** Whether this member holds Flatmates - "lives here", as opposed to a guest who joined by invite. */
export function isFlatmate(guild: GuildDto | null | undefined, member: GuildMemberDto | null | undefined): boolean {
    const role = findFlatmatesRole(guild);
    if (!role || !member) return false;
    return (member.roleMembers ?? []).some(rm => rm.role.id === role.id);
}
