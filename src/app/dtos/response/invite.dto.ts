import {GuildDto} from './guild.dto';
import {WelcomeScreen} from './guild-safety.dto';

export enum InviteType {
    OneTime = 'OneTime',
    Permanent = 'Permanent',
}

export enum InviteState {
    Active = 'Active',
    Expired = 'Expired',
}

export interface InviteDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    type: InviteType;
    state: InviteState;
    guildId: string;
    guild?: GuildDto;
    code: string;
    expiresAt?: string;
    maxUses?: number;
    useCount: number;
    /**
     * Present only when the guild has a welcome screen and it's enabled. A non-member
     * can't read the welcome-screen endpoint, so this is the only way to show it before
     * joining.
     */
    welcomeScreen?: WelcomeScreen | null;
}