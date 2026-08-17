import {computed, effect, inject, Injectable, signal, untracked} from '@angular/core';
import {Subject} from 'rxjs';
import {GuildVoiceActivityDto} from '../dtos/response/guild-voice-activity.dto';
import {GuildVoiceService} from './guild-voice.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';

/** Who just started streaming, and where - the source event for a "X is live" notification. */
export interface StreamerWentLive {
    guildId: string;
    channelId: string;
    userId: string;
}

/** What the rail needs to know about one guild: how many people are in voice, and is anyone live. */
export interface GuildVoicePresence {
    participantCount: number;
    hasStream: boolean;
}

/** Who is in voice per guild, read once from the server's index and maintained from broadcast events. */
@Injectable({providedIn: 'root'})
export class GuildVoiceActivityService {
    private guildVoice = inject(GuildVoiceService);
    private guildWs = inject(GuildWebsocketService);
    private realtime = inject(RealtimeConnectionService);

    /** guildId -> channelId -> user ids. Keyed by user, not counted, so a duplicate cannot drift a tally. */
    private readonly members = signal<Record<string, Record<string, string[]>>>({});
    private readonly streamers = signal<Record<string, Record<string, string[]>>>({});

    /** shareId -> owner: the stop event names the share, not the sharer, so only this makes removal precise. */
    private readonly shareOwners = new Map<string, {guildId: string; channelId: string; userId: string}>();

    private readonly wentLive = new Subject<StreamerWentLive>();

    /** Fires once per person who starts streaming: never from a snapshot, never twice for a redelivery. */
    readonly streamerWentLive$ = this.wentLive.asObservable();

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
        // A reconnect is a gap in which joins and leaves went unobserved, so re-read the snapshot.
        effect(() => {
            if (this.realtime.connectionState() !== ConnectionState.Connected) return;
            untracked(() => this.refresh());
        });

        this.guildWs.userJoinedVoiceObservable.subscribe(e =>
            this.addMember(e.guildId, e.channelId, e.userId),
        );

        this.guildWs.userLeftVoiceObservable.subscribe(e =>
            this.removeMember(e.guildId, e.channelId, e.userId),
        );

        // Screen-share events carry no guildId; it is resolved from the roster this service holds.
        this.guildWs.voiceScreenShareStartedObservable.subscribe(e =>
            this.addStreamer(e.channelId, e.userId, e.shareId),
        );

        this.guildWs.voiceScreenShareStoppedObservable.subscribe(e =>
            this.removeStreamerByShare(e.channelId, e.shareId),
        );
    }

    /** Anyone currently streaming in one channel. */
    streamersIn(guildId: string, channelId: string): string[] {
        return this.streamers()[guildId]?.[channelId] ?? [];
    }

    /** Whether this user is streaming anywhere this client has a roster for. */
    isStreaming(userId: string): boolean {
        return Object.values(this.streamers()).some(channels =>
            Object.values(channels).some(ids => ids.includes(userId)),
        );
    }

    /** Which channel of a guild this user is streaming in, or undefined. */
    streamingChannelId(guildId: string, userId: string): string | undefined {
        const channels = this.streamers()[guildId];
        if (!channels) return undefined;
        for (const [channelId, userIds] of Object.entries(channels)) {
            if (userIds.includes(userId)) return channelId;
        }
        return undefined;
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

        // Hygiene, not correctness: stops resolve by shareId alone, so this only stops the map growing.
        for (const [shareId, owner] of this.shareOwners) {
            if (owner.guildId === guildId && owner.channelId === channelId && owner.userId === userId) {
                this.shareOwners.delete(shareId);
            }
        }
    }

    /** Records a share starting; `streamerWentLive$` fires only when this genuinely adds someone. */
    private addStreamer(channelId: string, userId: string, shareId: string): void {
        const guildId = this.guildOf(channelId);
        if (!guildId) return;

        this.shareOwners.set(shareId, {guildId, channelId, userId});

        let added = false;
        this.streamers.update(state => {
            const channels = state[guildId] ?? {};
            const existing = channels[channelId] ?? [];
            if (existing.includes(userId)) return state;
            added = true;
            return {...state, [guildId]: {...channels, [channelId]: [...existing, userId]}};
        });

        if (added) this.wentLive.next({guildId, channelId, userId});
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
