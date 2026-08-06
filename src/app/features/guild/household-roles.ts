import {GuildDto, RoleDto, RoleType} from '../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../dtos/response/member.dto';

/**
 * The `Flatmates` role: the difference between somebody who lives here and somebody who is
 * visiting.
 *
 * <p>A guild created with `kind: "Household"` is seeded with it at position 1, holding the owner.
 * It carries the four household manage bits (`ManageLists`, `ManageChores`, `ManageLedger`,
 * `ManageGuests`) and - the part that matters - <b>its membership is the default chore rotation
 * pool</b>.</p>
 *
 * <p>So adding somebody to it is the product's way of saying they live here, and it is why a guest
 * who joined by invite is never assigned the bins: a guest holds `@everyone`, which since the
 * modules shipped carries the seven <i>participation</i> bits (shop, tick, complete a chore, add an
 * expense they paid, stock the pantry, vote) and none of the manage ones. Both can use the house;
 * only one is on the rota.</p>
 *
 * <p>Matched by name because the server seeds it by name and the client is never told its id. That
 * makes it a <b>heuristic, not a guarantee</b>: a house that renames the role, or that has
 * `Flatmates` in a non-household guild, is simply not recognised here. Every caller treats a miss
 * as "no default to offer" and never as "this person is a guest" - nothing is denied on the
 * strength of it.</p>
 */
export const FLATMATES_ROLE_NAME = 'Flatmates';

/** The seeded Flatmates role, or undefined in a guild that has none (or renamed it). */
export function findFlatmatesRole(guild: GuildDto | null | undefined): RoleDto | undefined {
    return (guild?.roles ?? []).find(role =>
        role.type !== RoleType.Everyone
        && role.name.trim().toLowerCase() === FLATMATES_ROLE_NAME.toLowerCase());
}

/**
 * The role a new chore's rotation should default to.
 *
 * <p>Which is the whole reason the role is seeded: without it every new chore starts on an empty
 * pool picker, and the first thing anybody does is pick the one role in the list.</p>
 */
export function defaultRotationRoleId(guild: GuildDto | null | undefined): string | null {
    return findFlatmatesRole(guild)?.id ?? null;
}

/** Whether this member holds Flatmates - "lives here", as opposed to a guest who joined by invite. */
export function isFlatmate(guild: GuildDto | null | undefined, member: GuildMemberDto | null | undefined): boolean {
    const role = findFlatmatesRole(guild);
    if (!role || !member) return false;
    return (member.roleMembers ?? []).some(rm => rm.role.id === role.id);
}
