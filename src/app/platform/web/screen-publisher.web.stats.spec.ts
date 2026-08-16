import {describe, expect, it} from 'vitest';
import {WebScreenPublisher} from './screen-publisher.web';

function statsReport(stats: RTCStats[]): RTCStatsReport {
    return {forEach: (cb: (s: RTCStats) => void) => stats.forEach(cb)} as unknown as RTCStatsReport;
}

/** The minimum of the adapter's private `live` record that `stats()` reads. */
function withLive(publisher: WebScreenPublisher, shareId: string, report: RTCStatsReport): void {
    (publisher as unknown as {live: unknown}).live = {
        shareId,
        pc: {getStats: () => Promise.resolve(report)},
    };
}

describe('WebScreenPublisher.stats', () => {
    it('reads the running publication and returns an outbound snapshot', async () => {
        const publisher = new WebScreenPublisher();
        withLive(publisher, 'share-1', statsReport([
            {type: 'outbound-rtp', kind: 'video', mid: '0', id: 'o1', ssrc: 1, frameWidth: 1920} as unknown as RTCStats,
        ]));

        const snapshot = await publisher.stats('share-1');

        expect(snapshot?.direction).toBe('outbound');
        expect(snapshot?.layers[0].width).toBe(1920);
    });

    /**
     * The port's stale-id rule: a stale id must not silently address whoever is publishing now.
     * See the doc on ScreenPublisher.stop.
     */
    it('answers null for a share id that is not the running one', async () => {
        const publisher = new WebScreenPublisher();
        withLive(publisher, 'share-1', statsReport([]));

        expect(await publisher.stats('share-stale')).toBeNull();
    });

    it('answers null when nothing is publishing', async () => {
        expect(await new WebScreenPublisher().stats('share-1')).toBeNull();
    });
});
