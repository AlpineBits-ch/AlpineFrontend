import {
    bitrateFor,
    boxFor,
    clampPreset,
    CONTENT_OPTIONS,
    DEFAULT_STREAM_PRESET,
    FRAMERATE_OPTIONS,
    isAudioOnlyCeiling,
    isFramerateAllowed,
    isResolutionAllowed,
    RESOLUTION_LABELS,
    resolutionHeight,
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
        expect(bitrateFor({resolution: '2160p', framerate: 15})).toBe(5000);
        expect(bitrateFor({resolution: '2160p', framerate: 30})).toBe(10000);
        expect(bitrateFor({resolution: '2160p', framerate: 60})).toBe(16000);
        expect(bitrateFor({resolution: 'source', framerate: 15})).toBe(6000);
        expect(bitrateFor({resolution: 'source', framerate: 30})).toBe(10000);
        expect(bitrateFor({resolution: 'source', framerate: 60})).toBe(18000);
    });

    it('keeps source above the tallest measured resolution', () => {
        for (const framerate of FRAMERATE_OPTIONS) {
            expect(bitrateFor({resolution: '2160p', framerate})).toBeLessThanOrEqual(
                bitrateFor({resolution: 'source', framerate}),
            );
        }
    });

    it('rises with resolution at a fixed framerate', () => {
        const ladder: StreamResolution[] = ['720p', '1080p', '1440p', '2160p'];
        for (const framerate of FRAMERATE_OPTIONS) {
            for (let i = 1; i < ladder.length; i++) {
                expect(bitrateFor({resolution: ladder[i - 1], framerate})).toBeLessThan(
                    bitrateFor({resolution: ladder[i], framerate}),
                );
            }
        }
    });

    it('resolves a bitrate for every declared resolution and framerate', () => {
        const resolutions: StreamResolution[] = ['720p', '1080p', '1440p', '2160p', 'source'];
        for (const resolution of resolutions) {
            for (const framerate of FRAMERATE_OPTIONS) {
                expect(bitrateFor({resolution, framerate})).toBeGreaterThan(0);
            }
        }
    });

    it('rises with framerate at a fixed resolution', () => {
        const resolutions: StreamResolution[] = ['720p', '1080p', '1440p', '2160p', 'source'];
        for (const resolution of resolutions) {
            expect(bitrateFor({resolution, framerate: 15})).toBeLessThan(
                bitrateFor({resolution, framerate: 30}),
            );
            expect(bitrateFor({resolution, framerate: 30})).toBeLessThan(
                bitrateFor({resolution, framerate: 60}),
            );
        }
    });

    it('maps resolutions to pixel boxes and source to null', () => {
        expect(boxFor('720p')).toEqual([1280, 720]);
        expect(boxFor('1080p')).toEqual([1920, 1080]);
        expect(boxFor('1440p')).toEqual([2560, 1440]);
        expect(boxFor('2160p')).toEqual([3840, 2160]);
        expect(boxFor('source')).toBeNull();
    });

    /** H.264 4:2:0 cannot represent an odd edge, and the simulcast halves and quarters must clear it too. */
    it('offers only boxes the encoder can accept, down to the quarter layer', () => {
        for (const resolution of Object.keys(RESOLUTION_LABELS) as StreamResolution[]) {
            const box = boxFor(resolution);
            if (!box) continue;
            for (const edge of box) {
                expect(edge % 4).toBe(0);
            }
        }
    });

    it('labels every resolution and offers the three Discord framerates', () => {
        expect(Object.keys(RESOLUTION_LABELS)).toEqual(['720p', '1080p', '1440p', '2160p', 'source']);
        expect(FRAMERATE_OPTIONS).toEqual<StreamFramerate[]>([15, 30, 60]);
    });

    it('defaults to 1080p30', () => {
        expect(DEFAULT_STREAM_PRESET).toEqual({resolution: '1080p', framerate: 30, content: 'text'});
    });
});

/** The picker against a granted rung. */
describe('a granted video rung', () => {
    /** 720p30, which is what a free guild resolves to on the published ladder. */
    const RUNG_720P30 = {maxHeight: 720, maxFramerate: 30};

    it('offers everything when nothing has stated a ceiling', () => {
        // "No information" means offer it and let the server answer.
        for (const resolution of ['720p', '1080p', '1440p', '2160p', 'source'] as StreamResolution[]) {
            expect(isResolutionAllowed(resolution, null)).toBe(true);
        }
        for (const fps of FRAMERATE_OPTIONS) expect(isFramerateAllowed(fps, null)).toBe(true);
        expect(clampPreset({resolution: '1440p', framerate: 60, content: 'text'}, null)).toEqual({
            resolution: '1440p',
            framerate: 60,
            content: 'text',
        });
    });

    it('stops the picker where the rung stops', () => {
        expect(isResolutionAllowed('720p', RUNG_720P30)).toBe(true);
        expect(isResolutionAllowed('1080p', RUNG_720P30)).toBe(false);
        expect(isResolutionAllowed('1440p', RUNG_720P30)).toBe(false);
        expect(isResolutionAllowed('2160p', RUNG_720P30)).toBe(false);
        expect(isFramerateAllowed(30, RUNG_720P30)).toBe(true);
        expect(isFramerateAllowed(60, RUNG_720P30)).toBe(false);
    });

    /** Rule 2, and the one that is easy to get backwards: a slower option is never a violation. */
    it('allows every lower framerate on any rung above none', () => {
        expect(isFramerateAllowed(15, RUNG_720P30)).toBe(true);
        expect(isFramerateAllowed(15, {maxHeight: 1080, maxFramerate: 60})).toBe(true);
    });

    it('keeps offering source, whose height it cannot know', () => {
        expect(resolutionHeight('source')).toBeNull();
        expect(isResolutionAllowed('source', RUNG_720P30)).toBe(true);
        expect(clampPreset({resolution: 'source', framerate: 30, content: 'text'}, RUNG_720P30)).toEqual({
            resolution: 'source',
            framerate: 30,
            content: 'text',
        });
    });

    it('clamps a saved preset down to the tallest and fastest the rung permits', () => {
        expect(clampPreset({resolution: '1440p', framerate: 60, content: 'text'}, RUNG_720P30)).toEqual({
            resolution: '720p',
            framerate: 30,
            content: 'text',
        });
        expect(
            clampPreset(
                {resolution: '1080p', framerate: 60, content: 'text'},
                {maxHeight: 1080, maxFramerate: 30},
            ),
        ).toEqual({resolution: '1080p', framerate: 30, content: 'text'});
    });

    it('returns the same object when nothing needed clamping', () => {
        // Identity, not just equality: a fresh object per call would churn the signal holding it.
        const preset = {resolution: '720p', framerate: 30, content: 'text'} as const;
        expect(clampPreset(preset, RUNG_720P30)).toBe(preset);
    });

    it('treats none as audio-only rather than as a very small ceiling', () => {
        const none = {maxHeight: 0, maxFramerate: 0};
        expect(isAudioOnlyCeiling(none)).toBe(true);
        expect(isAudioOnlyCeiling(RUNG_720P30)).toBe(false);
        expect(isAudioOnlyCeiling(null)).toBe(false);
        expect(isResolutionAllowed('720p', none)).toBe(false);
        expect(isFramerateAllowed(15, none)).toBe(false);
        expect(clampPreset({resolution: '1080p', framerate: 60, content: 'text'}, none)).toEqual({
            resolution: '1080p',
            framerate: 60,
            content: 'text',
        });
    });

    /** Negative case: a ceiling below every measured option leaves the choice alone to be clamped. */
    it('leaves a preset alone when no measured resolution fits under the ceiling', () => {
        expect(
            clampPreset(
                {resolution: '1080p', framerate: 30, content: 'text'},
                {maxHeight: 480, maxFramerate: 30},
            ),
        ).toEqual({resolution: '1080p', framerate: 30, content: 'text'});
    });
});

/** The top of the ladder, which is what a Pro guild resolves to. */
describe('the 2160p60 rung', () => {
    const RUNG_2160P60 = {maxHeight: 2160, maxFramerate: 60};
    const RUNG_1440P60 = {maxHeight: 1440, maxFramerate: 60};
    /** What the shipped operator ceiling produces today, whatever the guild's plan resolved to. */
    const RUNG_1080P60 = {maxHeight: 1080, maxFramerate: 60};

    it('offers every measured resolution at the top rung', () => {
        for (const resolution of ['720p', '1080p', '1440p', '2160p', 'source'] as StreamResolution[]) {
            expect(isResolutionAllowed(resolution, RUNG_2160P60)).toBe(true);
        }
        expect(isFramerateAllowed(60, RUNG_2160P60)).toBe(true);
    });

    it('measures 2160p rather than treating it as another source', () => {
        // Unlike `source` it has a height this client knows, so a rung below it hides it.
        expect(resolutionHeight('2160p')).toBe(2160);
    });

    it('hides 4K on every rung below it', () => {
        expect(isResolutionAllowed('2160p', RUNG_1440P60)).toBe(false);
        expect(isResolutionAllowed('1440p', RUNG_1440P60)).toBe(true);
        // Today's live behaviour under the shipped operator ceiling.
        expect(isResolutionAllowed('2160p', RUNG_1080P60)).toBe(false);
        expect(isResolutionAllowed('1440p', RUNG_1080P60)).toBe(false);
    });

    it('clamps up to 4K only where the rung reaches it', () => {
        expect(clampPreset({resolution: 'source', framerate: 60, content: 'games'}, RUNG_2160P60)).toEqual({
            resolution: 'source',
            framerate: 60,
            content: 'games',
        });
        // A preset taller than the rung falls to the tallest the rung does permit.
        expect(clampPreset({resolution: '2160p', framerate: 60, content: 'games'}, RUNG_1440P60)).toEqual({
            resolution: '1440p',
            framerate: 60,
            content: 'games',
        });
        expect(clampPreset({resolution: '2160p', framerate: 60, content: 'games'}, RUNG_1080P60)).toEqual({
            resolution: '1080p',
            framerate: 60,
            content: 'games',
        });
    });

    /** A 4K share is still a choice, never a default: nobody is opted into the egress. */
    it('does not move the default', () => {
        expect(DEFAULT_STREAM_PRESET.resolution).toBe('1080p');
    });
});

describe('the content axis', () => {
    it('defaults to text, so no existing share changes behaviour', () => {
        expect(DEFAULT_STREAM_PRESET.content).toBe('text');
    });

    it('offers exactly the two modes', () => {
        expect(CONTENT_OPTIONS).toEqual(['games', 'text']);
    });

    /** The content mode is not an entitlement axis, so a clamp must carry it through untouched. */
    it('survives a clamp that moves resolution and framerate', () => {
        const clamped = clampPreset(
            {resolution: '1440p', framerate: 60, content: 'games'},
            {maxHeight: 720, maxFramerate: 30},
        );
        expect(clamped).toEqual({resolution: '720p', framerate: 30, content: 'games'});
    });
});
