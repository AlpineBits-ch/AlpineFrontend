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
        expect(DEFAULT_STREAM_PRESET).toEqual({resolution: '1080p', framerate: 30, content: 'text'});
    });
});

/**
 * The picker against a granted rung.
 *
 * <p>Guide section 9. The rung's `maxHeight` and `maxFramerate` are the whole of the mapping and
 * they arrive on the wire; nothing in this file decides what 1440p or `source` is worth, because
 * that is a pricing decision and one made in a `.ts` file is one nobody can change later.</p>
 */
describe('a granted video rung', () => {
    /** 720p30, which is what a free guild resolves to on the published ladder. */
    const RUNG_720P30 = {maxHeight: 720, maxFramerate: 30};

    it('offers everything when nothing has stated a ceiling', () => {
        // Normal case on every instance that sells nothing: a client-side clamp is a courtesy, so
        // "no information" has to mean "offer it and let the server answer".
        for (const resolution of ['720p', '1080p', '1440p', 'source'] as StreamResolution[]) {
            expect(isResolutionAllowed(resolution, null)).toBe(true);
        }
        for (const fps of FRAMERATE_OPTIONS) expect(isFramerateAllowed(fps, null)).toBe(true);
        expect(clampPreset({resolution: '1440p', framerate: 60, content: 'text'}, null))
            .toEqual({resolution: '1440p', framerate: 60, content: 'text'});
    });

    it('stops the picker where the rung stops', () => {
        expect(isResolutionAllowed('720p', RUNG_720P30)).toBe(true);
        expect(isResolutionAllowed('1080p', RUNG_720P30)).toBe(false);
        expect(isResolutionAllowed('1440p', RUNG_720P30)).toBe(false);
        expect(isFramerateAllowed(30, RUNG_720P30)).toBe(true);
        expect(isFramerateAllowed(60, RUNG_720P30)).toBe(false);
    });

    /** Rule 2, and the one that is easy to get backwards: a slower option is never a violation. */
    it('allows every lower framerate on any rung above none', () => {
        expect(isFramerateAllowed(15, RUNG_720P30)).toBe(true);
        expect(isFramerateAllowed(15, {maxHeight: 1080, maxFramerate: 60})).toBe(true);
    });

    /**
     * Rule 4. `source` has no height this client can know, so disabling it would be inventing the
     * mapping the ladder exists to publish - the server clamps it and says so with a degradation.
     */
    it('keeps offering source, whose height it cannot know', () => {
        expect(resolutionHeight('source')).toBeNull();
        expect(isResolutionAllowed('source', RUNG_720P30)).toBe(true);
        expect(clampPreset({resolution: 'source', framerate: 30, content: 'text'}, RUNG_720P30))
            .toEqual({resolution: 'source', framerate: 30, content: 'text'});
    });

    it('clamps a saved preset down to the tallest and fastest the rung permits', () => {
        expect(clampPreset({resolution: '1440p', framerate: 60, content: 'text'}, RUNG_720P30))
            .toEqual({resolution: '720p', framerate: 30, content: 'text'});
        expect(clampPreset({resolution: '1080p', framerate: 60, content: 'text'}, {maxHeight: 1080, maxFramerate: 30}))
            .toEqual({resolution: '1080p', framerate: 30, content: 'text'});
    });

    it('returns the same object when nothing needed clamping', () => {
        // Identity, not just equality: this is read inside a publish path and a fresh object per
        // call would churn the signal that holds it.
        const preset = {resolution: '720p', framerate: 30, content: 'text'} as const;
        expect(clampPreset(preset, RUNG_720P30)).toBe(preset);
    });

    /**
     * `none` is a real rung meaning audio-only, never an absence and never an error. It is not a
     * ceiling to clamp against either: the answer to it is not publishing, which is a decision the
     * caller makes and this function does not.
     */
    it('treats none as audio-only rather than as a very small ceiling', () => {
        const none = {maxHeight: 0, maxFramerate: 0};
        expect(isAudioOnlyCeiling(none)).toBe(true);
        expect(isAudioOnlyCeiling(RUNG_720P30)).toBe(false);
        expect(isAudioOnlyCeiling(null)).toBe(false);
        expect(isResolutionAllowed('720p', none)).toBe(false);
        expect(isFramerateAllowed(15, none)).toBe(false);
        expect(clampPreset({resolution: '1080p', framerate: 60, content: 'text'}, none))
            .toEqual({resolution: '1080p', framerate: 60, content: 'text'});
    });

    /** Negative case: a ceiling below every measured option leaves the choice alone to be clamped. */
    it('leaves a preset alone when no measured resolution fits under the ceiling', () => {
        expect(clampPreset({resolution: '1080p', framerate: 30, content: 'text'}, {maxHeight: 480, maxFramerate: 30}))
            .toEqual({resolution: '1080p', framerate: 30, content: 'text'});
    });

});

describe('the content axis', () => {
    /**
     * The default is what every share did before the axis existed. Pinned because flipping it is a
     * one-word change that would silently alter how every existing user's stream degrades.
     */
    it('defaults to text, so no existing share changes behaviour', () => {
        expect(DEFAULT_STREAM_PRESET.content).toBe('text');
    });

    it('offers exactly the two modes', () => {
        expect(CONTENT_OPTIONS).toEqual(['games', 'text']);
    });

    /**
     * The content mode is not an entitlement axis, so a clamp must carry it through untouched. It
     * would otherwise be silently reset to the default every time a room capped the resolution.
     */
    it('survives a clamp that moves resolution and framerate', () => {
        const clamped = clampPreset(
            {resolution: '1440p', framerate: 60, content: 'games'},
            {maxHeight: 720, maxFramerate: 30},
        );
        expect(clamped).toEqual({resolution: '720p', framerate: 30, content: 'games'});
    });
});
