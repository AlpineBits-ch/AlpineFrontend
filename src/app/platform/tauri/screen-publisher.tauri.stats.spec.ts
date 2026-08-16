import {describe, expect, it} from 'vitest';
import {publishStatsToSnapshot} from './screen-publisher.tauri';

describe('publishStatsToSnapshot', () => {
    it('maps a native payload to an outbound snapshot marked native', () => {
        const snapshot = publishStatsToSnapshot({
            codec: 'video/H264',
            // The row that tells a level problem from a network one - see step 4b of the Rust task.
            profileLevelId: '42e01f',
            rttMs: 18,
            layers: [{
                rid: 'a', ssrc: 1, mid: '0', width: 1920, height: 1080, fps: 30, targetKbps: 2600,
                bytesSent: 1000, packetsSent: 10, packetsLost: 3, nackCount: 2, pliCount: 1,
                firCount: null, framesEncoded: 900, keyframes: 4, framesDropped: 2,
                encoder: 'openh264',
            }],
            audio: null,
        });

        expect(snapshot.direction).toBe('outbound');
        // The panel branches on this to omit rows webrtc-rs structurally cannot fill, qp among them.
        expect(snapshot.source).toBe('native');
        expect(snapshot.profileLevelId).toBe('42e01f');
        expect(snapshot.transport?.rttMs).toBe(18);
        expect(snapshot.layers[0]).toMatchObject({
            rid: 'a', width: 1920, targetKbps: 2600, framesEncoded: 900, encoder: 'openh264',
        });
    });

    it('never invents a qp for a native payload', () => {
        const snapshot = publishStatsToSnapshot({
            codec: null, profileLevelId: null, rttMs: null,
            layers: [{
                rid: 'a', ssrc: null, mid: null, width: 1920, height: 1080, fps: 30, targetKbps: 2600,
                bytesSent: 0, packetsSent: 0, packetsLost: null, nackCount: 0, pliCount: null,
                firCount: null, framesEncoded: 0, keyframes: 0, framesDropped: 0, encoder: 'openh264',
            }],
            audio: null,
        });

        expect(snapshot.layers[0].qp).toBeUndefined();
    });

    it('carries bytesSent through so the caller can differentiate it into a rate', () => {
        const snapshot = publishStatsToSnapshot({
            codec: null, profileLevelId: null, rttMs: null,
            layers: [{
                rid: 'a', ssrc: null, mid: null, width: 1, height: 1, fps: 1, targetKbps: 1,
                bytesSent: 125_000, packetsSent: 0, packetsLost: null, nackCount: 0, pliCount: null,
                firCount: null, framesEncoded: 0, keyframes: 0, framesDropped: 0, encoder: 'x',
            }],
            audio: null,
        });

        // kbps is not set here: the adapter has one sample and no interval. The service adds it.
        expect(snapshot.layers[0].kbps).toBeUndefined();
        expect(snapshot.layers[0].bytesSent).toBe(125_000);
    });
});
