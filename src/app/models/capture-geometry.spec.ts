import {solveGeometry} from './capture-geometry';

/** No rung has been resolved, which is what every call passed before ceilings were threaded in. */
const UNKNOWN = null;

describe('solveGeometry', () => {
    it('fits a 16:9 source into the target box exactly', () => {
        expect(solveGeometry(3840, 2160, '1080p', UNKNOWN)).toEqual({width: 1920, height: 1080});
    });

    it('preserves aspect ratio for an ultrawide source', () => {
        // 5120x1440 is 32:9. Fitting into 1920x1080 is width-bound: 1920x540.
        expect(solveGeometry(5120, 1440, '1080p', UNKNOWN)).toEqual({width: 1920, height: 540});
    });

    it('preserves aspect ratio for a portrait source', () => {
        // 1080x1920 is 9:16. Fitting into 1920x1080 is height-bound: 607.5 -> even 606.
        expect(solveGeometry(1080, 1920, '1080p', UNKNOWN)).toEqual({width: 606, height: 1080});
    });

    it('never upscales a source smaller than the box', () => {
        expect(solveGeometry(1280, 720, '1440p', UNKNOWN)).toEqual({width: 1280, height: 720});
    });

    it('returns the source size for the source resolution', () => {
        expect(solveGeometry(2560, 1080, 'source', UNKNOWN)).toEqual({width: 2560, height: 1080});
    });

    it('rounds odd dimensions down to even ones', () => {
        // H.264 4:2:0 chroma subsampling requires even width and height.
        expect(solveGeometry(1287, 863, 'source', UNKNOWN)).toEqual({width: 1286, height: 862});
    });

    it('never returns a dimension below 2', () => {
        expect(solveGeometry(1, 1, 'source', UNKNOWN)).toEqual({width: 2, height: 2});
    });

    it('keeps the source aspect ratio within a pixel across every resolution', () => {
        const sourceRatio = 3440 / 1440;
        for (const resolution of ['720p', '1080p', '1440p', '2160p', 'source'] as const) {
            const {width, height} = solveGeometry(3440, 1440, resolution, UNKNOWN);
            // Even-rounding can shift the ratio slightly, so allow a 2% tolerance.
            expect(Math.abs(width / height - sourceRatio) / sourceRatio).toBeLessThan(0.02);
        }
    });
});

/** The rung as a second box, which is the only thing that caps `source`. */
describe('solveGeometry against a granted rung', () => {
    const RUNG_720P30 = {maxHeight: 720, maxFramerate: 30};
    const RUNG_1080P60 = {maxHeight: 1080, maxFramerate: 60};
    const RUNG_2160P60 = {maxHeight: 2160, maxFramerate: 60};

    it('caps a 4K display shared as source down to the rung', () => {
        expect(solveGeometry(3840, 2160, 'source', RUNG_1080P60)).toEqual({width: 1920, height: 1080});
        expect(solveGeometry(3840, 2160, 'source', RUNG_720P30)).toEqual({width: 1280, height: 720});
    });

    it('leaves source alone when no rung has been resolved', () => {
        // The documented default: nothing said means offer it and let the server answer.
        expect(solveGeometry(3840, 2160, 'source', UNKNOWN)).toEqual({width: 3840, height: 2160});
    });

    it('does not upscale to reach a rung taller than the display', () => {
        expect(solveGeometry(1920, 1080, 'source', RUNG_2160P60)).toEqual({width: 1920, height: 1080});
    });

    it('preserves aspect ratio when the rung is what binds', () => {
        // 5120x1440 under a 720-line rung is height-bound: half of each edge.
        expect(solveGeometry(5120, 1440, 'source', RUNG_720P30)).toEqual({width: 2560, height: 720});
    });

    it('leaves a named resolution already inside the rung untouched', () => {
        expect(solveGeometry(3840, 2160, '1080p', RUNG_2160P60)).toEqual({width: 1920, height: 1080});
    });

    it('takes whichever of the box and the rung is smaller', () => {
        // The preset outlives the room it was chosen in, so this pairing is reachable.
        expect(solveGeometry(3840, 2160, '2160p', RUNG_1080P60)).toEqual({width: 1920, height: 1080});
    });

    it('treats the audio-only rung as no limit rather than a zero-height one', () => {
        expect(solveGeometry(1920, 1080, 'source', {maxHeight: 0, maxFramerate: 0})).toEqual({
            width: 1920,
            height: 1080,
        });
    });
});
