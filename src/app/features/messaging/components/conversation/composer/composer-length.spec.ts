import {describe, expect, it} from 'vitest';
import {lengthCounterClass, lengthState, MESSAGE_LENGTH_HARD_CEILING} from './composer-length';

describe('lengthState', () => {
    it('says nothing about a short reply', () => {
        const state = lengthState(120, 4_000);
        expect(state.visible).toBe(false);
        expect(state.level).toBe('idle');
        expect(state.blocked).toBe(false);
    });

    it('shows the counter once the post is long enough for the ceiling to matter', () => {
        expect(lengthState(2_400, 4_000).visible).toBe(true);
        expect(lengthState(2_399, 4_000).visible).toBe(false);
    });

    it('escalates near the ceiling', () => {
        expect(lengthState(3_600, 4_000).level).toBe('near');
    });

    it('blocks past the ceiling and counts down through zero', () => {
        const state = lengthState(4_312, 4_000);
        expect(state).toMatchObject({level: 'over', blocked: true, remaining: -312});
    });

    it('reads the ceiling it is given, not one baked in', () => {
        // The same post is fine in a Pro server and too long in a free one.
        expect(lengthState(9_000, 15_000).blocked).toBe(false);
        expect(lengthState(9_000, 4_000).blocked).toBe(true);
    });

    it('counts and blocks nothing while the guild plan is unknown', () => {
        const state = lengthState(9_000, null);
        expect(state).toMatchObject({max: null, remaining: null, visible: false, blocked: false});
    });

    it('still refuses what no plan could accept, even with an unknown ceiling', () => {
        const state = lengthState(MESSAGE_LENGTH_HARD_CEILING + 1, null);
        expect(state).toMatchObject({level: 'over', blocked: true, visible: true});
    });

    it('treats a nonsense ceiling as unknown rather than blocking everything', () => {
        expect(lengthState(10, 0).blocked).toBe(false);
    });
});

describe('lengthCounterClass', () => {
    it('gives each state its own weight', () => {
        expect(lengthCounterClass('over')).toContain('text-offline');
        expect(lengthCounterClass('near')).toContain('text-connecting');
        expect(lengthCounterClass('approaching')).toContain('text-text-muted');
    });
});
