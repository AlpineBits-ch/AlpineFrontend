/**
 * Builds the shared {@link CallParticipant} / {@link CallScreenShare} view models the call surfaces
 * render.
 *
 * <p><b>Why this exists.</b> The guild voice stage and the DM call panel each grew their own copy of
 * the same mapping, and the two drifted - different share-id sources, different fps lookups, one
 * carrying a rendered-fps number the other never set. Task 8's mini-player is a third renderer of
 * exactly the same view models from outside both stages, and a third copy is where a drift stops
 * being noticeable and starts being a bug. The mapping lives here instead, once per surface.</p>
 *
 * <p><b>Why two functions and not one.</b> The two surfaces do not merely differ in plumbing; they
 * identify a share differently and always have. Guild voice has one share per participant and keys
 * everything - including the inbound frame rate - by user id. A DM call carries a real per-share id
 * and must key by it, because `CallSessionService.onScreenShareStarted` dedupes by `shareId` alone,
 * so a stale share can sit in the model beside its replacement under the same user id. Collapsing
 * the two onto one key would make one share silently report the other's numbers - see the module
 * doc on `inbound-fps.ts`, which draws the same line one layer down. So the shape is shared, the
 * sourcing is not, and that is deliberate.</p>
 *
 * <p><b>Slices, not services.</b> Each function takes the narrow structural slice it reads rather
 * than the whole injectable, exactly as `InboundTrackOwner` does. Keeping the concrete services out
 * of this module keeps it free of Angular DI, so a caller can hand it plain signals in a test, and
 * so nothing here can drag a service into a bundle that had no business importing one.</p>
 */

import {CallParticipant, CallScreenShare} from './call.types';

/**
 * One row of the guild voice roster. `VoiceChannelParticipant` satisfies it; the two extra members
 * over {@link CallParticipant} are the ones the guild projections actually need - sharing is not
 * optional on this surface, and the share id comes off the roster rather than out of a share list.
 */
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
 *
 * <p>Three sources, in strict order, and the order is the whole point. A browser publish keeps its
 * display track in the webview, so that <i>is</i> the picture and nothing else applies. A native
 * publish has no such track: the tile decodes the encoded stream Rust hands back, and falls back to
 * the low-rate thumbnail on a webview that cannot decode - or before the first keyframe has been.
 * See `local-stream-render.ts` for why the second one exists at all.</p>
 *
 * <p>`localRender` is what the idle pause keys off, and it covers the second and third cases
 * together on purpose - both are pictures this app is producing for a tile that may not be looked
 * at, and a claim that named only one of them would let the pause fire over the other.</p>
 *
 * @param hostStream the local share's own track where the host has one, null on a native publish.
 */
function localSharePicture(publish: LocalPublishSources, hostStream: MediaStream | null): {
    stream: MediaStream | undefined;
    previewSrc: string | null;
    localRender: boolean;
} {
    if (hostStream) return {stream: hostStream, previewSrc: null, localRender: false};

    const decoded = publish.localPublishStream();
    const thumbnail = publish.publishPreview();
    return {
        stream: decoded ?? undefined,
        // Carried alongside the stream rather than dropped once it exists. `localPublishStream` is
        // only published once the canvas holds a picture, so before that this is what the tile
        // shows - and it is what remains if the decoder later gives up.
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
}

/**
 * The guild roster with each participant's camera track attached.
 *
 * <p>Resolved here rather than left to the tiles: the screen-share layout renders the roster as a
 * strip beside the streams, and without the track those tiles could only ever show avatars - so
 * turning on a camera did nothing visible the moment anybody shared a screen.</p>
 */
export function guildCallParticipants(
    media: GuildMediaSources,
    roster: readonly GuildRosterEntry[],
): CallParticipant[] {
    return roster.map(p => ({
        ...p,
        videoStream: p.isLocal ? media.localVideoStream() : media.getVideoStream(p.userId),
    }));
}

/**
 * Who in this channel is currently sharing.
 *
 * <p>The local user is folded in from `localState()` rather than trusted to appear in the roster:
 * this client knows its own share is up the instant it starts, well before the server has told
 * everyone - including us - about it.</p>
 */
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
            // Local: frames drawn by the local decoder - zero on a host that falls back to the
            // thumbnail, which is the honest answer there since nothing is being decoded. Remote:
            // not applicable, see inboundFps below.
            renderedFps: p.isLocal ? publish.renderedFps() : null,
            // Local: the Rust capture pipeline's own count. Remote: read off the inbound-rtp video stat
            // for that user's screen track - see VoiceRTCService.inboundVideoFps. Left at null rather
            // than 0 when the stat has not arrived yet, so a stream that just started and one that has
            // stalled do not look the same (CallScreenShare.inboundFps).
            inboundFps: p.isLocal ? publish.inboundFps() : (media.inboundVideoFps()[p.userId] ?? null),
        };
    });
}

/**
 * There is deliberately no DM counterpart to {@link guildCallParticipants}: `CallParticipantUi`
 * already carries its own camera track (`CallSessionService.onCameraChanged` sets it) and is
 * structurally a {@link CallParticipant} already, so the DM surfaces read
 * `session()?.participants ?? []` directly. Wrapping a field read in a function would be a
 * projection in name only.
 */
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
            // Own share: what the publisher actually opened, since a machine with no usable loopback
            // device shares video only. Remote share: assumed present, exactly as the guild tiles do -
            // the mute is a preference about that person's stream and is harmless to offer for one that
            // turns out to be silent.
            hasAudio: sh.isLocal ? session.localScreenHasAudio() : true,
            isAudioMuted: sh.isLocal ? session.localScreenAudioMuted() : rtc.isScreenAudioMuted(sh.userId),
            // Read off the inbound-rtp video stat for this share's own track - see
            // CallWebRtcService.inboundVideoFpsByShare. Keyed by share id, not user id, for the reason
            // in this module's doc. Left at null rather than 0 when the stat has not arrived yet, so a
            // stream that just started and one that has stalled do not look the same
            // (CallScreenShare.inboundFps).
            inboundFps: sh.isLocal ? null : (rtc.inboundVideoFpsByShare()[sh.shareId] ?? null),
        };
    });
}
