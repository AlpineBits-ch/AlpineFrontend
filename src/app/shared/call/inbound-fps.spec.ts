import {describe, expect, it} from 'vitest';
import {inboundScreenFpsByUser, InboundTrackOwner} from './inbound-fps';

/** A `getStats()`-shaped report: forEach over the stats it was given, nothing else. */
function report(stats: RTCStats[]): {forEach(callback: (stat: RTCStats) => void): void} {
    return {forEach: cb => stats.forEach(cb)};
}

function inboundRtpVideo(mid: string, framesPerSecond?: number): RTCStats {
    return {type: 'inbound-rtp', kind: 'video', mid, framesPerSecond} as unknown as RTCStats;
}

describe('inboundScreenFpsByUser', () => {
    it('gives two concurrent remote shares two independent fps numbers', () => {
        const tracks = new Map<string, InboundTrackOwner>([
            ['1', {userId: 'user-a', kind: 'screen'}],
            ['2', {userId: 'user-b', kind: 'screen'}],
        ]);

        const fps = inboundScreenFpsByUser(
            report([inboundRtpVideo('1', 30), inboundRtpVideo('2', 12)]),
            tracks,
        );

        expect(fps).toEqual({'user-a': 30, 'user-b': 12});
    });

    it('leaves a share out entirely when its stat has not reported a frame rate yet', () => {
        // A stream that has just started and one that is stalled must not look the same - see the
        // module doc. This is the "just started" half: no framesPerSecond key at all yet.
        const tracks = new Map<string, InboundTrackOwner>([['1', {userId: 'user-a', kind: 'screen'}]]);

        const fps = inboundScreenFpsByUser(report([inboundRtpVideo('1', undefined)]), tracks);

        expect(fps).toEqual({});
    });

    it('keeps a genuinely reported zero - the "stalled" half of the same distinction', () => {
        const tracks = new Map<string, InboundTrackOwner>([['1', {userId: 'user-a', kind: 'screen'}]]);

        const fps = inboundScreenFpsByUser(report([inboundRtpVideo('1', 0)]), tracks);

        expect(fps).toEqual({'user-a': 0});
    });

    it('ignores a camera track riding the same connection', () => {
        // kind: 'video' (camera), not 'screen' - inboundFps is a screen-share readout only.
        const tracks = new Map<string, InboundTrackOwner>([['1', {userId: 'user-a', kind: 'video'}]]);

        const fps = inboundScreenFpsByUser(report([inboundRtpVideo('1', 30)]), tracks);

        expect(fps).toEqual({});
    });

    it('ignores outbound and audio stats', () => {
        const tracks = new Map<string, InboundTrackOwner>([['1', {userId: 'user-a', kind: 'screen'}]]);
        const outbound = {type: 'outbound-rtp', kind: 'video', mid: '1'} as unknown as RTCStats;
        const audio = {type: 'inbound-rtp', kind: 'audio', mid: '1', framesPerSecond: 30} as unknown as RTCStats;

        const fps = inboundScreenFpsByUser(report([outbound, audio]), tracks);

        expect(fps).toEqual({});
    });
});
