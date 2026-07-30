export enum ChannelType {
    Text = 'Text',
    Voice = 'Voice',
    Thread = 'Thread',
    Forum = 'Forum',
    Announcement = 'Announcement',
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
    position: number;
    slowModeSeconds: number;
    parentChannelId: string | undefined;
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
    position: number;
}

export interface CategoryDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    name: string;
    description: string;
    permissions: ChannelPermission[];
    position: number;
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
    bannerUrl?: string;
    systemChannelId: string | null;
}

export enum RoleType {
    None = 'None',
    Everyone = 'Everyone',
}