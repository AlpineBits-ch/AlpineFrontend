import {describe, expect, it} from 'vitest';
import {inboundStatsFor, kbpsBetween, outboundStatsFromReport} from './stream-stats';

/** A `getStats()`-shaped report: forEach over the stats it was given, nothing else. */
function report(stats: RTCStats[]): {forEach(callback: (stat: RTCStats) => void): void} {
    return {forEach: cb => stats.forEach(cb)};
}

function inboundRtp(mid: string, extra: Record<string, unknown> = {}): RTCStats {
    return {type: 'inbound-rtp', kind: 'video', mid, id: `in-${mid}`, ...extra} as unknown as RTCStats;
}

describe('kbpsBetween', () => {
    it('turns two cumulative byte counts and an interval into kbps', () => {
        // 125000 bytes in 1s = 1000 kbps.
        expect(kbpsBetween(125_000, 0, 1)).toBe(1000);
    });

    it('answers undefined rather than a number when there is no previous sample', () => {
        // The first poll has nothing to differentiate against. Reporting 0 there would read as
        // "this stream is sending nothing", which is a different and much more alarming claim.
        expect(kbpsBetween(125_000, undefined, 1)).toBeUndefined();
    });

    it('answers undefined rather than Infinity when no time has passed', () => {
        expect(kbpsBetween(125_000, 0, 0)).toBeUndefined();
    });

    it('floors a counter that went backwards at zero instead of reporting a negative rate', () => {
        // Counters reset when a publication is rebuilt under the same panel.
        expect(kbpsBetween(10, 125_000, 1)).toBe(0);
    });
});

describe('inboundStatsFor', () => {
    it('reads the layer fields off the inbound-rtp stat for the given mid', () => {
        const snapshot = inboundStatsFor(
            report([
                inboundRtp('3', {
                    ssrc: 42,
                    frameWidth: 1920,
                    frameHeight: 1080,
                    framesPerSecond: 30,
                    framesDecoded: 900,
                    keyFramesDecoded: 4,
                    framesDropped: 2,
                    packetsReceived: 5000,
                    packetsLost: 7,
                    nackCount: 3,
                    pliCount: 1,
                    jitter: 0.012,
                }),
            ]),
            '3',
        );

        expect(snapshot?.direction).toBe('inbound');
        expect(snapshot?.source).toBe('webview');
        expect(snapshot?.layers).toEqual([
            {
                mid: '3',
                ssrc: 42,
                width: 1920,
                height: 1080,
                fps: 30,
                framesDecoded: 900,
                keyFrames: 4,
                framesDropped: 2,
                packets: 5000,
                packetsLost: 7,
                nackCount: 3,
                pliCount: 1,
                jitterMs: 12,
            },
        ]);
    });

    it('omits a field the report has not produced rather than defaulting it to zero', () => {
        // The distinction the whole model exists for - see the module doc on inbound-fps.ts.
        const snapshot = inboundStatsFor(report([inboundRtp('3', {ssrc: 42})]), '3');

        expect(snapshot?.layers[0]).toEqual({mid: '3', ssrc: 42});
        expect(snapshot?.layers[0].fps).toBeUndefined();
    });

    it('keeps a genuinely reported zero', () => {
        const snapshot = inboundStatsFor(report([inboundRtp('3', {framesPerSecond: 0})]), '3');

        expect(snapshot?.layers[0].fps).toBe(0);
    });

    it('answers null when no inbound stat carries that mid', () => {
        expect(inboundStatsFor(report([inboundRtp('3')]), '9')).toBeNull();
    });

    it('resolves the codec through the stat codecId', () => {
        const codec = {
            type: 'codec', id: 'codec-1', mimeType: 'video/H264',
            sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
        } as unknown as RTCStats;

        const snapshot = inboundStatsFor(report([inboundRtp('3', {codecId: 'codec-1'}), codec]), '3');

        expect(snapshot?.codec).toBe('video/H264');
        expect(snapshot?.profileLevelId).toBe('42e01f');
    });

    it('reads the succeeded candidate pair for the transport row', () => {
        const pair = {
            type: 'candidate-pair', id: 'pair-1', state: 'succeeded', nominated: true,
            currentRoundTripTime: 0.018, localCandidateId: 'lc', remoteCandidateId: 'rc',
            availableOutgoingBitrate: 2_500_000,
        } as unknown as RTCStats;
        const local = {type: 'local-candidate', id: 'lc', candidateType: 'srflx', protocol: 'udp'} as unknown as RTCStats;
        const remote = {type: 'remote-candidate', id: 'rc', candidateType: 'relay'} as unknown as RTCStats;

        const snapshot = inboundStatsFor(report([inboundRtp('3'), pair, local, remote]), '3');

        expect(snapshot?.transport).toEqual({
            rttMs: 18,
            localCandidateType: 'srflx',
            remoteCandidateType: 'relay',
            protocol: 'udp',
            availableOutgoingKbps: 2500,
        });
    });

    /**
     * The bitrate row is the number this whole readout exists to show, and a mapper that sees one
     * report cannot produce a rate. So it carries the cumulative counter and the service that owns
     * the poll differentiates it. Without this the panel on every remote share renders no bitrate
     * row at all, which is what shipped and what this guards.
     */
    it('carries the cumulative bytesReceived so the polling service can differentiate it', () => {
        const snapshot = inboundStatsFor(report([inboundRtp('3', {bytesReceived: 250_000})]), '3');

        expect(snapshot?.layers[0].bytesReceived).toBe(250_000);
        // Not a rate yet: one sample and no interval. The service adds `kbps`.
        expect(snapshot?.layers[0].kbps).toBeUndefined();
    });

    it('leaves bytesReceived absent when the report does not carry it', () => {
        const snapshot = inboundStatsFor(report([inboundRtp('3')]), '3');

        expect(snapshot?.layers[0].bytesReceived).toBeUndefined();
    });

    it('ignores a candidate pair that is not the succeeded one', () => {
        // A connection keeps failed and in-progress pairs in the report for its whole life.
        const failed = {
            type: 'candidate-pair', id: 'pair-1', state: 'failed', currentRoundTripTime: 9,
        } as unknown as RTCStats;

        const snapshot = inboundStatsFor(report([inboundRtp('3'), failed]), '3');

        expect(snapshot?.transport).toBeUndefined();
    });
});

function outboundRtp(mid: string, extra: Record<string, unknown> = {}): RTCStats {
    return {
        type: 'outbound-rtp', kind: 'video', mid, id: `out-${mid}-${extra['rid'] ?? 'solo'}`, ...extra,
    } as unknown as RTCStats;
}

describe('outboundStatsFromReport', () => {
    it('produces one layer per rid, highest first, for a simulcast publication', () => {
        const snapshot = outboundStatsFromReport(
            report([
                outboundRtp('1', {rid: 'b', ssrc: 2, frameWidth: 960, frameHeight: 540}),
                outboundRtp('1', {rid: 'a', ssrc: 1, frameWidth: 1920, frameHeight: 1080}),
            ]),
            '1',
        );

        expect(snapshot?.direction).toBe('outbound');
        expect(snapshot?.layers.map((l: typeof snapshot['layers'][number]) => l.rid)).toEqual(['a', 'b']);
        expect(snapshot?.layers[0].width).toBe(1920);
    });

    it('produces one unnamed layer for a single-encoding publication', () => {
        const snapshot = outboundStatsFromReport(report([outboundRtp('1', {ssrc: 1})]), '1');

        expect(snapshot?.layers).toHaveLength(1);
        expect(snapshot?.layers[0].rid).toBeUndefined();
    });

    it('reads the encoder fields a browser report carries', () => {
        const snapshot = outboundStatsFromReport(
            report([
                outboundRtp('1', {
                    ssrc: 1, framesPerSecond: 30, framesEncoded: 900, keyFramesEncoded: 4,
                    packetsSent: 5000, nackCount: 2, pliCount: 1, firCount: 0,
                    qpSum: 27_000, encoderImplementation: 'OpenH264',
                }),
            ]),
            '1',
        );

        expect(snapshot?.layers[0]).toMatchObject({
            fps: 30, framesEncoded: 900, keyFrames: 4, packets: 5000,
            nackCount: 2, pliCount: 1, firCount: 0, encoder: 'OpenH264',
        });
        // qpSum is cumulative over framesEncoded; the panel wants the average.
        expect(snapshot?.layers[0].qp).toBe(30);
    });

    it('omits qp when there are no encoded frames to average over', () => {
        const snapshot = outboundStatsFromReport(
            report([outboundRtp('1', {qpSum: 0, framesEncoded: 0})]), '1',
        );

        expect(snapshot?.layers[0].qp).toBeUndefined();
    });

    it('folds the remote inbound report into packets lost for the matching ssrc', () => {
        // The only view a sender has of what the receiver actually got.
        const remote = {
            type: 'remote-inbound-rtp', id: 'ri-1', kind: 'video', ssrc: 1,
            packetsLost: 12, roundTripTime: 0.021,
        } as unknown as RTCStats;

        const snapshot = outboundStatsFromReport(report([outboundRtp('1', {ssrc: 1}), remote]), '1');

        expect(snapshot?.layers[0].packetsLost).toBe(12);
        expect(snapshot?.transport?.rttMs).toBe(21);
    });

    it('answers null when no outbound stat carries that mid', () => {
        expect(outboundStatsFromReport(report([outboundRtp('1')]), '9')).toBeNull();
    });

    /**
     * The web host's own share had no bitrate row at all, because this mapper dropped `bytesSent`
     * on the floor while `RustMediaService.pollOutbound` was looking for exactly that field. The
     * two mappers now agree on the layer shape, which is what lets one differentiation loop serve
     * both hosts rather than the service growing a branch per publisher.
     */
    it('carries the cumulative bytesSent per layer, the same field the native mapper carries', () => {
        const snapshot = outboundStatsFromReport(
            report([
                outboundRtp('1', {rid: 'b', ssrc: 2, bytesSent: 60_000}),
                outboundRtp('1', {rid: 'a', ssrc: 1, bytesSent: 400_000}),
            ]),
            '1',
        );

        expect(snapshot?.layers.map(l => l.bytesSent)).toEqual([400_000, 60_000]);
        // Not a rate yet: one sample and no interval. `pollOutbound` adds `kbps`.
        expect(snapshot?.layers[0].kbps).toBeUndefined();
    });

    it('leaves bytesSent absent when the report does not carry it', () => {
        const snapshot = outboundStatsFromReport(report([outboundRtp('1', {ssrc: 1})]), '1');

        expect(snapshot?.layers[0].bytesSent).toBeUndefined();
    });
});
