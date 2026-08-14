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
 */

/** The slice of a mid → track-owner map this needs. Both RTC services' real maps satisfy this. */
export interface InboundTrackOwner {
    userId: string;
    kind: 'audio' | 'video' | 'screen';
}

export function inboundScreenFpsByUser(
    report: {forEach(callback: (stat: RTCStats) => void): void},
    tracks: ReadonlyMap<string, InboundTrackOwner>,
): Record<string, number> {
    const fps: Record<string, number> = {};

    report.forEach(stat => {
        if (stat.type !== 'inbound-rtp') return;
        const s = stat as RTCInboundRtpStreamStats;
        if (s.kind !== 'video' || typeof s.framesPerSecond !== 'number' || !s.mid) return;

        const owner = tracks.get(s.mid);
        if (owner?.kind === 'screen') fps[owner.userId] = s.framesPerSecond;
    });

    return fps;
}
