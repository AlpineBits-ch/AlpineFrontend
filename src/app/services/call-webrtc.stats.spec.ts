import {describe, expect, it} from 'vitest';
import {detailedStatsForShare} from './call-webrtc.service';
import {InboundTrackOwner} from '../shared/call/inbound-fps';

function report(stats: RTCStats[]): {forEach(callback: (stat: RTCStats) => void): void} {
    return {forEach: cb => stats.forEach(cb)};
}

function inboundRtp(mid: string, extra: Record<string, unknown> = {}): RTCStats {
    return {type: 'inbound-rtp', kind: 'video', mid, id: `in-${mid}`, ...extra} as unknown as RTCStats;
}

describe('detailedStatsForShare', () => {
    /**
     * The case this keying exists for: onScreenShareStarted dedupes by shareId alone, so a stale
     * share can sit alongside its replacement under one userId. Keyed by user, the panel would
     * silently show the other stream's numbers.
     */
    it('picks the right stream when one user has two shares', () => {
        const tracks = new Map<string, InboundTrackOwner>([
            ['1', {userId: 'user-a', kind: 'screen', shareId: 'share-old'}],
            ['2', {userId: 'user-a', kind: 'screen', shareId: 'share-new'}],
        ]);

        const snapshot = detailedStatsForShare(
            report([inboundRtp('1', {frameWidth: 640}), inboundRtp('2', {frameWidth: 1920})]),
            tracks,
            'share-new',
        );

        expect(snapshot?.layers[0].width).toBe(1920);
    });

    it('answers null when the inspected share has no transceiver', () => {
        const tracks = new Map<string, InboundTrackOwner>([
            ['1', {userId: 'user-a', kind: 'screen', shareId: 'share-a'}],
        ]);

        expect(detailedStatsForShare(report([inboundRtp('1')]), tracks, 'share-gone')).toBeNull();
    });

    it('answers null when nothing is being inspected', () => {
        const tracks = new Map<string, InboundTrackOwner>([
            ['1', {userId: 'user-a', kind: 'screen', shareId: 'share-a'}],
        ]);

        expect(detailedStatsForShare(report([inboundRtp('1')]), tracks, null)).toBeNull();
    });
});
