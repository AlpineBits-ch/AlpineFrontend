import { GuildMemberDto, MemberBanState, MemberType, RoleDto } from './guild.dto';

export type { GuildMemberDto };
export { MemberBanState, MemberType };

export interface RoleMemberDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    role: RoleDto;
    roleId: string;
    memberId: string;
}
