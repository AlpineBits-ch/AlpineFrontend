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
    Online = 'Online',
    Offline = 'Offline',
}