/** One voice channel with somebody in it, as reported by the guild voice-activity snapshot. */
export interface GuildVoiceActivityChannelDto {
    channelId: string;
    participantCount: number;
    userIds: string[];
    hasStream: boolean;
    streamerIds: string[];
}

/**
 * Voice occupancy for one guild.
 *
 * <p>Only channels the caller may see are included, and a guild with nobody in voice is omitted
 * from the response entirely rather than returned empty - so the presence of an entry is itself
 * the "something is happening here" signal.</p>
 */
export interface GuildVoiceActivityDto {
    guildId: string;
    participantCount: number;
    hasStream: boolean;
    channels: GuildVoiceActivityChannelDto[];
}
