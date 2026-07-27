import {GuildDto} from './guild.dto';

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
}