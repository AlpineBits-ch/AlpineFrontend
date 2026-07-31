import {solveGeometry} from './capture-geometry';

describe('solveGeometry', () => {
    it('fits a 16:9 source into the target box exactly', () => {
        expect(solveGeometry(3840, 2160, '1080p')).toEqual({width: 1920, height: 1080});
    });

    it('preserves aspect ratio for an ultrawide source', () => {
        // 5120x1440 is 32:9. Fitting into 1920x1080 is width-bound: 1920x540.
        expect(solveGeometry(5120, 1440, '1080p')).toEqual({width: 1920, height: 540});
    });

    it('preserves aspect ratio for a portrait source', () => {
        // 1080x1920 is 9:16. Fitting into 1920x1080 is height-bound: 607.5 -> even 606.
        expect(solveGeometry(1080, 1920, '1080p')).toEqual({width: 606, height: 1080});
    });

    it('never upscales a source smaller than the box', () => {
        expect(solveGeometry(1280, 720, '1440p')).toEqual({width: 1280, height: 720});
    });

    it('returns the source size for the source resolution', () => {
        expect(solveGeometry(2560, 1080, 'source')).toEqual({width: 2560, height: 1080});
    });

    it('rounds odd dimensions down to even ones', () => {
        // H.264 4:2:0 chroma subsampling requires even width and height.
        expect(solveGeometry(1287, 863, 'source')).toEqual({width: 1286, height: 862});
    });

    it('never returns a dimension below 2', () => {
        expect(solveGeometry(1, 1, 'source')).toEqual({width: 2, height: 2});
    });

    it('keeps the source aspect ratio within a pixel across every resolution', () => {
        const sourceRatio = 3440 / 1440;
        for (const resolution of ['720p', '1080p', '1440p', 'source'] as const) {
            const {width, height} = solveGeometry(3440, 1440, resolution);
            // Even-rounding can shift the ratio slightly; a 2% tolerance catches a genuine
            // aspect-ratio bug without failing on the rounding itself.
            expect(Math.abs(width / height - sourceRatio) / sourceRatio).toBeLessThan(0.02);
        }
    });
});
