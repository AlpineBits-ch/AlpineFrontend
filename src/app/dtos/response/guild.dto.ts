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

export interface CategoryDto {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  name: string;
  description: string;
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
  iconUrl?: string;
  bannerUrl?: string;
}
