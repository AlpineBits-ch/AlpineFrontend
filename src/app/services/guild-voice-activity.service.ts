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

    /**
     * shareId -> who is publishing it and where.
     *
     * <p>`WsVoiceScreenShareStopped` carries only a `shareId`, never a `userId` - the stop event
     * names the share, not the sharer. This is what turns "this share ended" back into "this
     * person is no longer streaming" without touching anyone else's entry in the channel. Filled
     * in by the matching start event; nothing repopulates it from a snapshot, because the snapshot
     * DTO does not carry share ids at all - see `replaceAll`.</p>
     */
    private readonly shareOwners = new Map<string, {guildId: string; channelId: string; userId: string}>();

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
            this.addStreamer(e.channelId, e.userId, e.shareId));

        this.guildWs.voiceScreenShareStoppedObservable.subscribe(e =>
            this.removeStreamerByShare(e.channelId, e.shareId));
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

        // Hygiene, not correctness: `removeStreamerByShare` never resolves through this map by
        // guild/channel/user, only by shareId, so a stale entry here could not misattribute a
        // future stop - it would just sit unread. Cleared anyway so the map does not grow for the
        // lifetime of the session.
        for (const [shareId, owner] of this.shareOwners) {
            if (owner.guildId === guildId && owner.channelId === channelId && owner.userId === userId) {
                this.shareOwners.delete(shareId);
            }
        }
    }

    /** Records a share starting, and lights the channel's live marker for its owner. */
    private addStreamer(channelId: string, userId: string, shareId: string): void {
        const guildId = this.guildOf(channelId);
        if (!guildId) return;

        this.shareOwners.set(shareId, {guildId, channelId, userId});

        this.streamers.update(state => {
            const channels = state[guildId] ?? {};
            const existing = channels[channelId] ?? [];
            if (existing.includes(userId)) return state;
            return {...state, [guildId]: {...channels, [channelId]: [...existing, userId]}};
        });
    }

    /**
     * Clears one streamer, resolved from the share that just stopped rather than guessed from the
     * channel.
     *
     * <p>The previous version of this cleared the whole channel's streamer list on every stop,
     * because `WsVoiceScreenShareStopped` carries no `userId` to remove precisely. That is wrong
     * whenever two people are streaming in the same channel: one of them stopping would dark the
     * marker for both, including the one still going. `shareOwners`, filled in by the matching
     * start event, is what makes the precise removal possible - see its own comment.</p>
     *
     * <p>A stop for a share this client never saw start (joined mid-share, or missed the event) is
     * a no-op here; `removeMember` is the fallback that catches a streamer disappearing without a
     * stop at all, e.g. the app closing mid-share.</p>
     */
    private removeStreamerByShare(channelId: string, shareId: string): void {
        const owner = this.shareOwners.get(shareId);
        this.shareOwners.delete(shareId);
        if (!owner) return;

        const {guildId, userId} = owner;
        this.streamers.update(state => {
            const channels = state[guildId] ?? {};
            const existing = channels[channelId] ?? [];
            if (!existing.includes(userId)) return state;
            return {...state, [guildId]: {...channels, [channelId]: existing.filter(id => id !== userId)}};
        });
    }

    private guildOf(channelId: string): string | undefined {
        for (const [guildId, channels] of Object.entries(this.members())) {
            if (channelId in channels) return guildId;
        }
        return undefined;
    }
}
