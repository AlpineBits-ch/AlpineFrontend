import {RoleDto} from "./guild.dto";
import {OnlineStatus, ProfileDto} from "./profile.dto";
import {MemberType} from "../../enums/member-type.enum";
import {Activity} from "../../models/activity.model";

export interface GuildMemberDto {
    id: string;
    guildId: string;
    userId: string;
    inviteId: string;
    /**
     * Optional because the server does not send it: the member row has no single mask, it has the
     * allow/deny pair below. Kept declared because `unionMemberPermissions` and the Superadmin
     * checks still read it, and reading `undefined` there is the same answer as reading `"None"` -
     * but nothing will ever put a value in it.
     */
    permissions?: string;
    /** The member's own module bits, in the separate {@link ModulePermissions} space. */
    modulePermissions?: string;
    /**
     * The member's own guild-level overrides, applied after their roles are unioned and before any
     * channel or category overwrite. Written by
     * `PATCH /guilds/{guildId}/members/{memberId}/permissions`.
     */
    allowPermissions?: string;
    /** @see allowPermissions */
    denyPermissions?: string;
    /** @see allowPermissions */
    allowModulePermissions?: string;
    /** @see allowPermissions */
    denyModulePermissions?: string;
    status: OnlineStatus;
    type: MemberType;
    nickname: string | null;
    profile: ProfileDto | undefined;
    readState: ReadStateDto[]
    // Contract change: GET /guilds/{guildId}/members must now include each member's role
    // assignments, same shape as GET /guilds/{guildId}/me already returns. Optional until the
    // backend ships this - frontend guards with `member.roleMembers ?? []`.
    roleMembers?: { role: RoleDto }[]
    /**
     * Rich presence, projected server-side through `ProjectActivitiesFor` — so what arrives here is
     * already filtered for the viewer's blocks, the subject's `shareActivity` setting, a `Hidden`
     * status and the per-application opt-out list. There is nothing left for the client to gate.
     *
     * <p>Optional exactly as `roleMembers` above: absent until the backend ships it, and absent
     * again for any member with nothing to report. Read it as `member.activities ?? []`.</p>
     */
    activities?: Activity[]
}

export interface SelfGuildMemberDto extends GuildMemberDto {
    roleMembers: { role: RoleDto }[]

    /**
     * What the caller may actually do in this guild, already resolved server-side: ownership,
     * every role, their own allow/deny, implied bits, and the clamp to enabled modules.
     *
     * <p>Prefer this over unioning `roleMembers[].role.permissions` yourself. That union cannot
     * see ownership — the owner's member row carries no permissions and their only role is
     * @everyone — so every caller had to remember to compare against `guild.ownerId` as well, and
     * the ones that forgot hid controls from the one person who always has them.</p>
     *
     * <p>Optional until the backend ships it. `undefined` means "not computed", not "none":
     * `effectiveGuildPermissions` falls back to the old union when it is absent.</p>
     *
     * <p>Arrives as a name list ("ViewChannel, ManageGuild") when .NET can name every bit and as a
     * bare number when it cannot - a resolved mask routinely carries bits this build has no name
     * for, so the numeric form is the common one, not the edge case. Always read it through
     * `parsePermissions`; nothing may treat it as a string.</p>
     *
     * <p><b>Core mask only.</b> There is no resolved counterpart for module permissions, so those
     * are unioned client-side by `guildAbilities` and carry exactly the ownership blind spot this
     * field exists to remove. The roles reachable from `roleMembers` here are a flat shape without
     * `modulePermissions` either, so that union resolves each role out of `guild.roles`.</p>
     */
    effectivePermissions?: string | number
}

/**
 * What `PATCH /guilds/{guildId}/members/{memberId}/permissions` answers with: the four masks as
 * they now stand, not a member row. The endpoint does not project one - see the note on its C#
 * side - so a caller holding a `GuildMemberDto` merges these four fields into it rather than
 * replacing it.
 */
export interface MemberPermissionsDto {
    allowPermissions: string;
    denyPermissions: string;
    allowModulePermissions: string;
    denyModulePermissions: string;
}


export interface RoleMemberDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    roleId: string;
    memberId: string;
    userId: string;
    /**
     * When a temporary (guest) grant stops counting. `null` on every ordinary membership, which is
     * every membership that predates guest access, and those behave exactly as before.
     *
     * <p><b>A past value means the role is no longer granted.</b> Permission resolution drops an
     * expired membership at the instant it expires, but the rows are only reaped about a week
     * later - so this endpoint keeps returning lapsed grants for days. Anything rendering a role
     * membership must run it through `grantState` in `features/guild/guest-access.ts` rather than
     * treating presence in the list as access.</p>
     */
    expiresAt?: string | null;
    member: {
        id: string;
        guildId: string;
        userId: string;
        createdAt: Date;
        updatedAt: Date;
    }
}

export interface ReadStateDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    channelId: string;
    lastReadMessageId: string | undefined;
    /**
     * @deprecated Always `0` since the inbox shipped. Do not read it.
     *
     * <p>It was a stored counter incremented per mention, and that stopped being possible when an
     * `@everyone` became one row rather than one row per member - there is no per-user write left
     * to increment. It was never idempotent either: a retried message doubled it and a deleted one
     * left it high forever. Counts are computed on read now.</p>
     *
     * <p>Still the same field of the same type, so nothing fails to deserialize - it just quietly
     * stopped being a number. For the badge use `GET /guild/inbox/summary`, and for per-channel
     * counts `GET /guild/inbox/unread`; {@link import('../../services/guild-read-state.service').GuildReadStateService}
     * seeds the sidebar from the latter.</p>
     */
    mentionCount: number;
    memberId: string;
}