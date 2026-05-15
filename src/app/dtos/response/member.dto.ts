import {RoleDto} from "./guild.dto";
import {OnlineStatus, ProfileDto} from "./profile.dto";

export interface GuildMemberDto {
    id: string;
    guildId: string;
    userId: string;
    inviteId: string;
    permissions: string;
    status: OnlineStatus;
    profile: ProfileDto | undefined;
    readState: ReadStateDto[]
}

export interface SelfGuildMemberDto extends GuildMemberDto {
    roleMembers: {role: RoleDto}[]
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