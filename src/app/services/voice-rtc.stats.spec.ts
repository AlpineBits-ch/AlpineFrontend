import {describe, expect, it} from 'vitest';
import {detailedStatsFor} from './voice-rtc.service';
import {InboundTrackOwner} from '../shared/call/inbound-fps';

function report(stats: RTCStats[]): {forEach(callback: (stat: RTCStats) => void): void} {
    return {forEach: cb => stats.forEach(cb)};
}

function inboundRtp(mid: string, extra: Record<string, unknown> = {}): RTCStats {
    return {type: 'inbound-rtp', kind: 'video', mid, id: `in-${mid}`, ...extra} as unknown as RTCStats;
}

describe('detailedStatsFor', () => {
    it('finds the mid for the inspected user and reads that stream', () => {
        const tracks = new Map<string, InboundTrackOwner>([
            ['1', {userId: 'user-a', kind: 'screen'}],
            ['2', {userId: 'user-b', kind: 'screen'}],
        ]);

        const snapshot = detailedStatsFor(
            report([inboundRtp('1', {frameWidth: 640}), inboundRtp('2', {frameWidth: 1920})]),
            tracks,
            'user-b',
        );

        expect(snapshot?.layers[0].width).toBe(1920);
    });

    it('answers null when the inspected user has no screen transceiver', () => {
        const tracks = new Map<string, InboundTrackOwner>([['1', {userId: 'user-a', kind: 'video'}]]);

        expect(detailedStatsFor(report([inboundRtp('1')]), tracks, 'user-a')).toBeNull();
    });

    it('answers null when nobody is being inspected', () => {
        const tracks = new Map<string, InboundTrackOwner>([['1', {userId: 'user-a', kind: 'screen'}]]);

        expect(detailedStatsFor(report([inboundRtp('1')]), tracks, null)).toBeNull();
    });
});
