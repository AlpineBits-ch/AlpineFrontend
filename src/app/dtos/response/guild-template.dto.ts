import {ChannelType} from './guild.dto';

export interface TemplateChannel {
    name: string;
    type: ChannelType;
    description?: string | null;
    position: number;
}

export interface TemplateCategory {
    name: string;
    position: number;
    channels: TemplateChannel[];
}

export interface TemplateRole {
    name: string;
    color: string;
    position: number;
    /** Raw bitmask as a number, not the comma-separated flag string used elsewhere. */
    permissions: number;
}

export interface GuildTemplateDto {
    id: string;
    name: string;
    description?: string | null;
    creatorUserId: string;
    createdAt: string;
    usageCount: number;
    /** Structure only - no permission overwrites, members, or messages are captured. */
    snapshot: {
        roles: TemplateRole[];
        categories: TemplateCategory[];
        uncategorizedChannels: TemplateChannel[];
    };
}
