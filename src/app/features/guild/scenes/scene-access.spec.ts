import {describe, expect, it} from 'vitest';

import {accessMeta, isPrivate, needsPermission, presetOf, SceneAccessPreset} from './scene-access';
import {SceneJoinPolicy, SceneVisibility} from '../../../dtos/response/scene.dto';

describe('scene access presets', () => {
    it('maps each legal pair to the table it is', () => {
        expect(presetOf(SceneJoinPolicy.Open, SceneVisibility.Everyone)).toBe(SceneAccessPreset.OpenTable);
        expect(presetOf(SceneJoinPolicy.Ask, SceneVisibility.Everyone)).toBe(SceneAccessPreset.AskToJoin);
        expect(presetOf(SceneJoinPolicy.Ask, SceneVisibility.Cast)).toBe(SceneAccessPreset.PrivateTable);
    });

    it('round-trips every preset through its pair', () => {
        for (const preset of Object.values(SceneAccessPreset)) {
            const meta = accessMeta(preset);
            expect(presetOf(meta.joinPolicy, meta.visibility)).toBe(preset);
        }
    });

    it('reads a scene with no access fields as an open table', () => {
        expect(presetOf(undefined, undefined)).toBe(SceneAccessPreset.OpenTable);
        expect(needsPermission({})).toBe(false);
        expect(isPrivate({})).toBe(false);
    });

    /** The server refuses this pair, so it can only arrive from an older row or a bad write. */
    it('reads a cast-only scene as private whatever its join policy says', () => {
        expect(presetOf(SceneJoinPolicy.Open, SceneVisibility.Cast)).toBe(SceneAccessPreset.PrivateTable);
    });

    it('answers what each half of the pair means', () => {
        expect(needsPermission({joinPolicy: SceneJoinPolicy.Ask})).toBe(true);
        expect(needsPermission({joinPolicy: SceneJoinPolicy.Open})).toBe(false);
        expect(isPrivate({visibility: SceneVisibility.Cast})).toBe(true);
        expect(isPrivate({visibility: SceneVisibility.Everyone})).toBe(false);
        expect(needsPermission(null)).toBe(false);
        expect(isPrivate(null)).toBe(false);
    });
});
