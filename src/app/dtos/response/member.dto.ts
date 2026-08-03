import {RoleDto} from "./guild.dto";
import {OnlineStatus, ProfileDto} from "./profile.dto";
import {MemberType} from "../../enums/member-type.enum";

export interface GuildMemberDto {
    id: string;
    guildId: string;
    userId: string;
    inviteId: string;
    permissions: string;
    status: OnlineStatus;
    type: MemberType;
    nickname: string | null;
    profile: ProfileDto | undefined;
    readState: ReadStateDto[]
    // Contract change: GET /guilds/{guildId}/members must now include each member's role
    // assignments, same shape as GET /guilds/{guildId}/me already returns. Optional until the
    // backend ships this - frontend guards with `member.roleMembers ?? []`.
    roleMembers?: { role: RoleDto }[]
}

export interface SelfGuildMemberDto extends GuildMemberDto {
    roleMembers: { role: RoleDto }[]
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