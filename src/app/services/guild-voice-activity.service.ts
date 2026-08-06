import {computed, effect, inject, Injectable, signal, untracked} from '@angular/core';
import {GuildVoiceActivityDto} from '../dtos/response/guild-voice-activity.dto';
import {GuildVoiceService} from './guild-voice.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';

/** What the rail needs to know about one guild: how many people are in voice, and is anyone live. */
export interface GuildVoicePresence {
    participantCount: number;
    hasStream: boolean;
}

/**
 * Who is in voice, per guild, for the indicator on the server rail.
 *
 * <p>Voice presence lives as one roster per channel, so "does this guild have anyone in voice"
 * would otherwise mean reading every channel of every guild on every launch. The server keeps a
 * per-guild index for exactly this question; this reads it once and then maintains it from the
 * events that were already being broadcast.</p>
 *
 * <p>Those events reach every member of the guild whether or not they are looking at it, so the
 * counts stay right for guilds this client has never opened - which is the whole point of a rail
 * indicator.</p>
 */
@Injectable({providedIn: 'root'})
export class GuildVoiceActivityService {
    private guildVoice = inject(GuildVoiceService);
    private guildWs = inject(GuildWebsocketService);
    private realtime = inject(RealtimeConnectionService);

    /** guildId -> channelId -> user ids. Keyed by user rather than counted, so a duplicated join
     *  or a leave for somebody already gone cannot drift a tally nothing would ever correct. */
    private readonly members = signal<Record<string, Record<string, string[]>>>({});
    private readonly streamers = signal<Record<string, Record<string, string[]>>>({});

    readonly presence = computed<Record<string, GuildVoicePresence>>(() => {
        const members = this.members();
        const streamers = this.streamers();
        const result: Record<string, GuildVoicePresence> = {};

        for (const [guildId, channels] of Object.entries(members)) {
            const participantCount = Object.values(channels).reduce((sum, ids) => sum + ids.length, 0);
            if (participantCount === 0) continue;
            result[guildId] = {
                participantCount,
                hasStream: Object.values(streamers[guildId] ?? {}).some(ids => ids.length > 0),
            };
        }

        return result;
    });

    constructor() {
        // Runs on creation with whatever the connection already is, and again on every change. A
        // reconnect is a gap in which joins and leaves happened unobserved, so the snapshot is
        // re-read rather than the stale counts being carried forward.
        effect(() => {
            if (this.realtime.connectionState() !== ConnectionState.Connected) return;
            untracked(() => this.refresh());
        });

        this.guildWs.userJoinedVoiceObservable.subscribe(e =>
            this.addMember(e.guildId, e.channelId, e.userId));

        this.guildWs.userLeftVoiceObservable.subscribe(e =>
            this.removeMember(e.guildId, e.channelId, e.userId));

        // Screen-share events carry no guildId - they are addressed to a channel. The guild is
        // resolved from the roster this service already holds, which is also the only case where
        // the marker means anything: a stream in a channel we have no roster for is a stream we
        // are not counting anybody in.
        this.guildWs.voiceScreenShareStartedObservable.subscribe(e =>
            this.setStreaming(e.channelId, e.userId, true));

        this.guildWs.voiceScreenShareStoppedObservable.subscribe(e =>
            this.setStreaming(e.channelId, undefined, false));
    }

    /** Re-reads the whole rail. Cheap - one request - and the only thing that can correct drift. */
    refresh(): void {
        this.guildVoice.getVoiceActivity().subscribe({
            next: activity => this.replaceAll(activity),
            // Silent: a missing indicator is not worth a toast, and the next connect tries again.
            error: () => void 0,
        });
    }

    private replaceAll(activity: GuildVoiceActivityDto[]): void {
        const members: Record<string, Record<string, string[]>> = {};
        const streamers: Record<string, Record<string, string[]>> = {};

        for (const guild of activity) {
            members[guild.guildId] = {};
            streamers[guild.guildId] = {};
            for (const channel of guild.channels) {
                members[guild.guildId][channel.channelId] = [...channel.userIds];
                streamers[guild.guildId][channel.channelId] = [...channel.streamerIds];
            }
        }

        this.members.set(members);
        this.streamers.set(streamers);
    }

    private addMember(guildId: string, channelId: string, userId: string): void {
        this.members.update(state => {
            const channels = state[guildId] ?? {};
            const existing = channels[channelId] ?? [];
            if (existing.includes(userId)) return state;
            return {...state, [guildId]: {...channels, [channelId]: [...existing, userId]}};
        });
    }

    private removeMember(guildId: string, channelId: string, userId: string): void {
        this.members.update(state => {
            const channels = state[guildId];
            const existing = channels?.[channelId];
            if (!existing?.includes(userId)) return state;
            return {
                ...state,
                [guildId]: {...channels, [channelId]: existing.filter(id => id !== userId)},
            };
        });

        // Somebody who left the channel is not still live in it. Their share ended with them.
        this.streamers.update(state => {
            const channels = state[guildId];
            const existing = channels?.[channelId];
            if (!existing?.includes(userId)) return state;
            return {
                ...state,
                [guildId]: {...channels, [channelId]: existing.filter(id => id !== userId)},
            };
        });
    }

    /**
     * Marks (or clears) a live stream in a channel.
     *
     * <p>A stop event names the share, not the sharer, so it clears the channel's streamers
     * wholesale. Overcorrecting by one person is a marker that goes dark a moment early on the rare
     * two-streamer channel; the snapshot puts it back. Undercorrecting would leave a "live" dot lit
     * for a stream that ended, which is the failure worth avoiding.</p>
     */
    private setStreaming(channelId: string, userId: string | undefined, streaming: boolean): void {
        const guildId = this.guildOf(channelId);
        if (!guildId) return;

        this.streamers.update(state => {
            const channels = state[guildId] ?? {};
            if (!streaming) return {...state, [guildId]: {...channels, [channelId]: []}};
            if (!userId) return state;
            const existing = channels[channelId] ?? [];
            if (existing.includes(userId)) return state;
            return {...state, [guildId]: {...channels, [channelId]: [...existing, userId]}};
        });
    }

    private guildOf(channelId: string): string | undefined {
        for (const [guildId, channels] of Object.entries(this.members())) {
            if (channelId in channels) return guildId;
        }
        return undefined;
    }
}
