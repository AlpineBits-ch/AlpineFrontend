export interface ProfileDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    userName: string;
    bio: string | undefined;
    userId: string;
    avatarUrl: string | undefined;
    bannerUrl: string | undefined;
    accentColor: string | null;
    font: ProfileFont;
    onlineStatus: OnlineStatus;
}

export enum OnlineStatus {
    Offline = 'Offline',
    Hidden = 'Hidden',
    Online = 'Online',
    Idle = 'Idle',
    DoNotDisturb = 'DoNotDisturb',
}

export enum ProfileFont {
    Default = 'Default',
    Serif = 'Serif',
    Monospace = 'Monospace',
    Rounded = 'Rounded',
    Display = 'Display',
    Handwritten = 'Handwritten',
}