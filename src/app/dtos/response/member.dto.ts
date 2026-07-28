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
    mentionCount: number;
    memberId: string;
}