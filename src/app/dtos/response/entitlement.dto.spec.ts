import {describe, expect, it} from 'vitest';
import {
    degradationsOf,
    EntitlementRungDto,
    isGranted,
    moduleStandingOf,
    numericCeiling,
    rungMetrics,
} from './entitlement.dto';

describe('numericCeiling', () => {
    it('reads a limit', () => {
        expect(numericCeiling({kind: 'numeric', value: 26214400, unlimited: false})).toBe(26214400);
    });

    /**
     * Unlimited is carried as a flag and a null, never as a sentinel: the server's own "no ceiling"
     * is `long.MaxValue`, which is larger than Number.MAX_SAFE_INTEGER and would be corrupted here
     * with nothing to show for it. Reading `value` without reading `unlimited` is the mistake this
     * function exists to make impossible.
     */
    it('answers null for unlimited', () => {
        expect(numericCeiling({kind: 'numeric', value: null, unlimited: true})).toBeNull();
    });

    it('answers null for a key that is not held, so nothing is enforced against a guess', () => {
        expect(numericCeiling(undefined)).toBeNull();
    });

    it('answers null for a value in the wrong shape', () => {
        expect(numericCeiling({kind: 'flag', granted: true})).toBeNull();
    });
});

describe('isGranted', () => {
    it('reads a flag', () => {
        expect(isGranted({kind: 'flag', granted: true})).toBe(true);
        expect(isGranted({kind: 'flag', granted: false})).toBe(false);
    });

    it('is false for a key that is not held', () => {
        expect(isGranted(undefined)).toBe(false);
    });
});

describe('rungMetrics', () => {
    const ladder: EntitlementRungDto[] = [
        {rung: 'none', rank: 0, maxHeight: 0, maxFramerate: 0},
        {rung: '720p30', rank: 2, maxHeight: 720, maxFramerate: 30},
        {rung: '1080p60', rank: 4, maxHeight: 1080, maxFramerate: 60},
    ];

    it('reads what the granted rung permits', () => {
        expect(rungMetrics(ladder, {kind: 'ladder', rung: '720p30', rank: 2}))
            .toEqual({maxHeight: 720, maxFramerate: 30});
    });

    /** `none` is a real rung and means audio-only, not an absence. */
    it('reads the audio-only rung as a real one', () => {
        expect(rungMetrics(ladder, {kind: 'ladder', rung: 'none', rank: 0}))
            .toEqual({maxHeight: 0, maxFramerate: 0});
    });

    /**
     * A rung the ladder does not describe clamps nothing. Deciding here that 1440p30 becomes
     * 1080p30 would be a pricing decision made in a TypeScript file, which is the one thing the
     * server publishes its ladder to prevent.
     */
    it('clamps nothing when the ladder does not describe the rung', () => {
        expect(rungMetrics(ladder, {kind: 'ladder', rung: '1440p30', rank: 5})).toBeNull();
        expect(rungMetrics(undefined, {kind: 'ladder', rung: '720p30', rank: 2})).toBeNull();
        expect(rungMetrics(ladder, {kind: 'numeric', value: 3, unlimited: false})).toBeNull();
    });
});

describe('degradationsOf', () => {
    it('reads the array off a response that carried one', () => {
        const body = {id: 'msg-1', degradations: [{key: 'voice.video_ceiling'}]};

        expect(degradationsOf(body)).toHaveLength(1);
    });

    /**
     * Absent and empty mean the same thing, and both are the normal case - a response with nothing
     * reduced is byte-identical to what a client that had never heard of this receives.
     */
    it('treats a response with nothing reduced as the normal case', () => {
        expect(degradationsOf({id: 'msg-1'})).toEqual([]);
        expect(degradationsOf({degradations: []})).toEqual([]);
        expect(degradationsOf(null)).toEqual([]);
        expect(degradationsOf('nope')).toEqual([]);
    });

    it('ignores a degradations field that is not an array', () => {
        expect(degradationsOf({degradations: {key: 'voice.video_ceiling'}})).toEqual([]);
    });
});

describe('moduleStandingOf', () => {
    const resolution = {
        chosen: ['Forums', 'Events', 'Wiki'],
        includedByPlan: ['Events', 'Wiki'],
        withheldByPlan: ['Forums'],
        effective: ['Events', 'Wiki'],
    };

    it('reads a module that is on', () => {
        expect(moduleStandingOf(resolution, 'Events')).toBe('on');
    });

    /**
     * The distinction the three lists exist for. "The owner asked for this and is not getting it"
     * and "the owner turned it off" are the same absence from `effective` and different sentences,
     * and only one of them has an upgrade next to it.
     */
    it('tells a withheld module from one the owner turned off', () => {
        expect(moduleStandingOf(resolution, 'Forums')).toBe('withheld');
        expect(moduleStandingOf(resolution, 'Polls')).toBe('off');
    });

    it('says nothing at all when no resolution is held', () => {
        expect(moduleStandingOf(null, 'Forums')).toBe('unknown');
    });
});
