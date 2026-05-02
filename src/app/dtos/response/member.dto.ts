import {RoleDto} from "./guild.dto";

export interface GuildMemberDto {
    id: string;
    guildId: string;
    userId: string;
    inviteId: string;
}

export enum MemberType {
    Default = 'Default',
    Moderator = 'Moderator',
    Admin = 'Admin',
    Owner = 'Owner',
}

export interface RoleMemberDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    role: RoleDto
    roleId: string;
    memberId: string;
}
