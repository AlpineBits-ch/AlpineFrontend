/**
 * Builds the shared {@link CallParticipant} / {@link CallScreenShare} view models the call surfaces
 * render. Guild voice keys by user id, DM by share id, and the two must not be collapsed onto one key.
 */

import {CallParticipant, CallScreenShare} from './call.types';

/** One row of the guild voice roster. `VoiceChannelParticipant` satisfies it. */
export interface GuildRosterEntry extends CallParticipant {
    isScreenSharing: boolean;
    /** The share's own id where the server has given us one; the guild side falls back to userId. */
    mediaSessionId?: string | null;
}

/** The slice of `VoiceChannelService` the guild projections read. The real service satisfies it. */
export interface GuildMediaSources {
    localState(): {isScreenSharing: boolean};
    localVideoStream(): MediaStream | null;
    getVideoStream(userId: string): MediaStream | null;
    localScreenStream(): MediaStream | null;
    getScreenStream(userId: string): MediaStream | null;
    localScreenHasAudio(): boolean;
    localScreenAudioMuted(): boolean;
    isScreenAudioMuted(userId: string): boolean;
    inboundVideoFps(): Record<string, number>;
    /** Whether this user's picture is between tracks and expected back. */
    isScreenResuming(userId: string): boolean;
}

/** The slice of `CallSessionService` the DM projections read. */
export interface DmSessionSources {
    localScreenHasAudio(): boolean;
    localScreenAudioMuted(): boolean;
}

/** The slice of `CallWebRtcService` the DM share projection reads. */
export interface DmRtcSources {
    isScreenAudioMuted(userId: string): boolean;
    inboundVideoFpsByShare(): Record<string, number>;
}

/** The slice of `RustMediaService` both surfaces read for the local share. */
export interface LocalPublishSources {
    publishPreview(): string | null;
    localPublishStream(): MediaStream | null;
    renderedFps(): number;
    inboundFps(): number;
}

/**
 * What to show in the local share's tile, and whether it is this app's own render of the publish.
 * Three sources in strict order: host track, decoded publish, thumbnail.
 *
 * @param hostStream the local share's own track where the host has one, null on a native publish.
 */
function localSharePicture(
    publish: LocalPublishSources,
    hostStream: MediaStream | null,
): {
    stream: MediaStream | undefined;
    previewSrc: string | null;
    localRender: boolean;
} {
    if (hostStream) return {stream: hostStream, previewSrc: null, localRender: false};

    const decoded = publish.localPublishStream();
    const thumbnail = publish.publishPreview();
    return {
        stream: decoded ?? undefined,
        // Carried alongside the stream rather than dropped once it exists: it fills the gap before
        // the canvas holds a picture, and remains if the decoder later gives up.
        previewSrc: thumbnail,
        localRender: decoded !== null || thumbnail !== null,
    };
}

/** One row of `ActiveCallSession.screenShares`. */
export interface DmShareEntry {
    shareId: string;
    userId: string;
    displayName: string;
    isLocal: boolean;
    stream: MediaStream | undefined;
    /** Set by `CallSessionService` while a seat is being held. */
    state?: 'live' | 'resuming';
}

/** The guild roster with each participant's camera track attached. */
export function guildCallParticipants(
    media: GuildMediaSources,
    roster: readonly GuildRosterEntry[],
): CallParticipant[] {
    return roster.map(p => ({
        ...p,
        videoStream: p.isLocal ? media.localVideoStream() : media.getVideoStream(p.userId),
    }));
}

/** Who in this channel is currently sharing. The local user is folded in from `localState()`. */
export function guildScreenSharers(
    media: GuildMediaSources,
    roster: readonly GuildRosterEntry[],
): GuildRosterEntry[] {
    const sharers = roster.filter(p => p.isScreenSharing);
    if (media.localState().isScreenSharing && !sharers.some(p => p.isLocal)) {
        const local = roster.find(p => p.isLocal);
        if (local) return [...sharers, {...local, isScreenSharing: true}];
    }
    return sharers;
}

export function guildScreenShares(
    media: GuildMediaSources,
    publish: LocalPublishSources,
    roster: readonly GuildRosterEntry[],
): CallScreenShare[] {
    return guildScreenSharers(media, roster).map(p => {
        const own = p.isLocal ? localSharePicture(publish, media.localScreenStream()) : null;
        return {
            shareId: p.mediaSessionId ?? p.userId,
            userId: p.userId,
            displayName: p.displayName,
            avatarLabel: p.avatarLabel,
            isLocal: p.isLocal,
            stream: own ? own.stream : (media.getScreenStream(p.userId) ?? undefined),
            previewSrc: own?.previewSrc ?? null,
            localRender: own?.localRender ?? false,
            hasAudio: p.isLocal ? media.localScreenHasAudio() : true,
            isAudioMuted: p.isLocal ? media.localScreenAudioMuted() : media.isScreenAudioMuted(p.userId),
            // Local: frames drawn by the local decoder. Remote: not applicable.
            renderedFps: p.isLocal ? publish.renderedFps() : null,
            // Local: the Rust capture pipeline's own count. Remote: the inbound-rtp video stat.
            // Must stay null rather than 0 before the stat arrives, or a new stream reads as stalled.
            inboundFps: p.isLocal ? publish.inboundFps() : (media.inboundVideoFps()[p.userId] ?? null),
            // Never for the local share: this client is the publisher, so it has no gap to hold across.
            state: !p.isLocal && media.isScreenResuming(p.userId) ? 'resuming' : 'live',
        };
    });
}

export function dmScreenShares(
    session: DmSessionSources,
    rtc: DmRtcSources,
    publish: LocalPublishSources,
    shares: readonly DmShareEntry[],
): CallScreenShare[] {
    return shares.map(sh => {
        const own = sh.isLocal ? localSharePicture(publish, sh.stream ?? null) : null;
        return {
            shareId: sh.shareId,
            userId: sh.userId,
            displayName: sh.displayName,
            avatarLabel: sh.displayName[0]?.toUpperCase() ?? '?',
            isLocal: sh.isLocal,
            stream: own ? own.stream : sh.stream,
            previewSrc: own?.previewSrc ?? null,
            localRender: own?.localRender ?? false,
            // Own share: what the publisher actually opened. Remote share: assumed present.
            hasAudio: sh.isLocal ? session.localScreenHasAudio() : true,
            isAudioMuted: sh.isLocal ? session.localScreenAudioMuted() : rtc.isScreenAudioMuted(sh.userId),
            // The inbound-rtp video stat, keyed by share id and not user id. Must stay null rather
            // than 0 before the stat arrives, or a new stream reads as stalled.
            inboundFps: sh.isLocal ? null : (rtc.inboundVideoFpsByShare()[sh.shareId] ?? null),
            // Never for the local share: this client is the publisher.
            state: !sh.isLocal && sh.state === 'resuming' ? 'resuming' : 'live',
        };
    });
}
