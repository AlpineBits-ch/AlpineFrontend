
export enum ChannelType {
  Text  = 'Text',
  Voice = 'Voice',
}

export interface ChannelDto {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  name: string;
  description: string;
  type: ChannelType;
  guildId: string;
  isAgeRestricted: boolean;
  isPrivate: boolean;
  categoryId: string | undefined;
  permissions: ChannelPermission[];
}

export interface ChannelPermission {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  channelId: string | undefined;
  roleId: string | undefined;
  memberId: string | undefined;
  categoryId: string | undefined;
  allowPermissions: string;
  denyPermissions: string;
}

export interface RoleDto {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  name: string;
  description: string;
  color: string;
  guildId: string;
  userId: string;
  permissions: string;
  type: RoleType;
}

export enum RoleType {
  None     = 'None',
  Everyone = 'Everyone',
}

export interface CategoryDto {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  name: string;
  description: string;
  permissions: ChannelPermission[];
}

export enum InviteType {
  OneTime   = 'OneTime',
  Permanent = 'Permanent',
}

export enum InviteState {
  Active  = 'Active',
  Expired = 'Expired',
}

export interface InviteDto {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  type: InviteType;
  state: InviteState;
  guildId: string;
}

// ── Guild member types (defined here to avoid circular deps with member.dto.ts) ──

export enum MemberBanState {
  None   = 'None',
  Banned = 'Banned',
}

export enum MemberType {
  Default   = 'Default',
  Moderator = 'Moderator',
  Admin     = 'Admin',
  Owner     = 'Owner',
}

export interface GuildMemberDto {
  id: string;
  guildId: string;
  userId: string;
  inviteId: string;
  permissions: string;
  banState: MemberBanState;
  banReason: string;
}

export interface GuildDto {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  name: string;
  description: string;
  ownerId: string;
  categories: CategoryDto[];
  channels: ChannelDto[];
  roles: RoleDto[];
  members?: GuildMemberDto[];
  iconUrl?: string;
  bannerUrl?: string;
}
