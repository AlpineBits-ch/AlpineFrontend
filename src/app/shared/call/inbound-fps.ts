/**
 * Reads each remote screen share's arriving frame rate off a WebRTC `getStats()` report.
 *
 * <p>Shared between {@link CallWebRtcService} and the guild voice equivalent, `VoiceRTCService`,
 * because both poll the same standard `inbound-rtp` stat and both already keep a mid → track-owner
 * map to route `ontrack` events - `framesPerSecond` just rides the same lookup.</p>
 *
 * <p>Rebuilt from scratch on every poll rather than merged into a running map: a share that stops
 * sending frames must disappear from here on its own, not linger at its last known number. That is
 * also why a stat missing `framesPerSecond` entirely is skipped rather than recorded as `0` - the
 * browser has not decoded a frame yet, which reads to a caller as "no data", not "stalled at zero".
 * A stat that genuinely reports `0` (a stream that started and then froze) is kept, because that is
 * the honest, distinguishable other case - see `CallScreenShare.inboundFps`.</p>
 *
 * <p>Two keying schemes, not one, because the two services' track-owner maps carry different
 * information. `VoiceRTCService`'s `midMeta` has no per-share id at all - the guild side has always
 * identified a screen stream by its owner - and a guild `CallScreenShare[]` is built one row per
 * participant (`call-projection.ts`'s `guildScreenSharers`), so a userId can never collide
 * there. `CallWebRtcService`'s `midMap` does carry a `shareId`, and on the DM surface a userId *can*
 * collide: `CallSessionService.onScreenShareStarted` dedupes incoming shares by `shareId` alone, so
 * a stale share lingering across a rapid stop/restart race can sit in the model alongside its
 * replacement, both under the same `userId`. Keying that side by user would make one of the two
 * silently show the other's number; keying by share id is what actually closes that.</p>
 */

/** The slice of a mid → track-owner map this needs. Both RTC services' real maps satisfy this. */
export interface InboundTrackOwner {
    userId: string;
    kind: 'audio' | 'video' | 'screen';
    /** Only ever set for `kind: 'screen'`, and only on the DM surface - see the module doc. */
    shareId?: string;
}

function inboundScreenFpsBy(
    report: {forEach(callback: (stat: RTCStats) => void): void},
    tracks: ReadonlyMap<string, InboundTrackOwner>,
    keyOf: (owner: InboundTrackOwner) => string | undefined,
): Record<string, number> {
    const fps: Record<string, number> = {};

    report.forEach(stat => {
        if (stat.type !== 'inbound-rtp') return;
        const s = stat as RTCInboundRtpStreamStats;
        if (s.kind !== 'video' || typeof s.framesPerSecond !== 'number' || !s.mid) return;

        const owner = tracks.get(s.mid);
        if (owner?.kind !== 'screen') return;
        const key = keyOf(owner);
        if (key) fps[key] = s.framesPerSecond;
    });

    return fps;
}

/**
 * The guild-voice keying: `VoiceRTCService.midMeta` carries no per-share id, and its
 * `CallScreenShare[]` is built one row per participant, so a userId can never collide.
 */
export function inboundScreenFpsByUser(
    report: {forEach(callback: (stat: RTCStats) => void): void},
    tracks: ReadonlyMap<string, InboundTrackOwner>,
): Record<string, number> {
    return inboundScreenFpsBy(report, tracks, owner => owner.userId);
}

/**
 * The DM-call keying: `CallWebRtcService.midMap` carries a `shareId` for every `kind: 'screen'`
 * entry (both the live `TrackPublished` path and the snapshot backfill pass one in), and a userId
 * can genuinely collide there - see the module doc.
 */
export function inboundScreenFpsByShare(
    report: {forEach(callback: (stat: RTCStats) => void): void},
    tracks: ReadonlyMap<string, InboundTrackOwner>,
): Record<string, number> {
    return inboundScreenFpsBy(report, tracks, owner => owner.shareId);
}
