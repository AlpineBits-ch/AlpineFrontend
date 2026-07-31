import {
    bitrateFor,
    boxFor,
    DEFAULT_STREAM_PRESET,
    FRAMERATE_OPTIONS,
    RESOLUTION_LABELS,
    StreamFramerate,
    StreamResolution,
} from './stream-preset';

describe('stream-preset', () => {
    it('derives the documented bitrate for every combination', () => {
        expect(bitrateFor({resolution: '720p', framerate: 15})).toBe(1500);
        expect(bitrateFor({resolution: '720p', framerate: 30})).toBe(2500);
        expect(bitrateFor({resolution: '720p', framerate: 60})).toBe(4000);
        expect(bitrateFor({resolution: '1080p', framerate: 15})).toBe(2500);
        expect(bitrateFor({resolution: '1080p', framerate: 30})).toBe(4500);
        expect(bitrateFor({resolution: '1080p', framerate: 60})).toBe(8000);
        expect(bitrateFor({resolution: '1440p', framerate: 15})).toBe(4000);
        expect(bitrateFor({resolution: '1440p', framerate: 30})).toBe(8000);
        expect(bitrateFor({resolution: '1440p', framerate: 60})).toBe(12000);
        expect(bitrateFor({resolution: 'source', framerate: 15})).toBe(6000);
        expect(bitrateFor({resolution: 'source', framerate: 30})).toBe(10000);
        expect(bitrateFor({resolution: 'source', framerate: 60})).toBe(18000);
    });

    it('resolves a bitrate for every declared resolution and framerate', () => {
        const resolutions: StreamResolution[] = ['720p', '1080p', '1440p', 'source'];
        for (const resolution of resolutions) {
            for (const framerate of FRAMERATE_OPTIONS) {
                expect(bitrateFor({resolution, framerate})).toBeGreaterThan(0);
            }
        }
    });

    it('rises with framerate at a fixed resolution', () => {
        const resolutions: StreamResolution[] = ['720p', '1080p', '1440p', 'source'];
        for (const resolution of resolutions) {
            expect(bitrateFor({resolution, framerate: 15}))
                .toBeLessThan(bitrateFor({resolution, framerate: 30}));
            expect(bitrateFor({resolution, framerate: 30}))
                .toBeLessThan(bitrateFor({resolution, framerate: 60}));
        }
    });

    it('maps resolutions to pixel boxes and source to null', () => {
        expect(boxFor('720p')).toEqual([1280, 720]);
        expect(boxFor('1080p')).toEqual([1920, 1080]);
        expect(boxFor('1440p')).toEqual([2560, 1440]);
        expect(boxFor('source')).toBeNull();
    });

    it('labels every resolution and offers the three Discord framerates', () => {
        expect(Object.keys(RESOLUTION_LABELS)).toEqual(['720p', '1080p', '1440p', 'source']);
        expect(FRAMERATE_OPTIONS).toEqual<StreamFramerate[]>([15, 30, 60]);
    });

    it('defaults to 1080p30', () => {
        expect(DEFAULT_STREAM_PRESET).toEqual({resolution: '1080p', framerate: 30});
    });
});
