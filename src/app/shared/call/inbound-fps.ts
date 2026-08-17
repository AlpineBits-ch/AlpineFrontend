/**
 * Reads each remote screen share's arriving frame rate off a WebRTC `getStats()` report.
 * Rebuilt from scratch each poll, and a stat with no `framesPerSecond` must be skipped, not recorded as 0.
 */

/** The slice of a mid → track-owner map this needs. Both RTC services' real maps satisfy this. */
export interface InboundTrackOwner {
    userId: string;
    kind: 'audio' | 'video' | 'screen';
    /** Only ever set for `kind: 'screen'`, and only on the DM surface. */
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

/** The guild-voice keying: one row per participant, so a userId can never collide. */
export function inboundScreenFpsByUser(
    report: {forEach(callback: (stat: RTCStats) => void): void},
    tracks: ReadonlyMap<string, InboundTrackOwner>,
): Record<string, number> {
    return inboundScreenFpsBy(report, tracks, owner => owner.userId);
}

/** The DM-call keying: a userId can genuinely collide there, so this must key by `shareId`. */
export function inboundScreenFpsByShare(
    report: {forEach(callback: (stat: RTCStats) => void): void},
    tracks: ReadonlyMap<string, InboundTrackOwner>,
): Record<string, number> {
    return inboundScreenFpsBy(report, tracks, owner => owner.shareId);
}
