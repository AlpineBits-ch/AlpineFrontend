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
}

export interface GuildDto {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  name: string;
  description: string;
  ownerId: string;
  channels: ChannelDto[];
  roles: RoleDto[];
  iconUrl?: string;
  bannerUrl?: string;
}
