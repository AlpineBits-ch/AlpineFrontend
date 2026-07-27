export interface ProfileDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    userName: string;
    bio: string | undefined;
    userId: string;
    avatarUrl: string | undefined;
    onlineStatus: OnlineStatus;
}

export enum OnlineStatus {
    Offline = 'Offline',
    Hidden = 'Hidden',
    Online = 'Online',
    Idle = 'Idle',
    DoNotDisturb = 'DoNotDisturb',
}