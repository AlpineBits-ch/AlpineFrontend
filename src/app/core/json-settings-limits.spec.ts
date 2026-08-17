import {describe, expect, it} from 'vitest';
import {checkJsonSettings, JSON_SETTINGS_MAX_BYTES, JSON_SETTINGS_MAX_DEPTH} from './json-settings-limits';

describe('checkJsonSettings', () => {
    it('accepts an ordinary settings object', () => {
        expect(checkJsonSettings({notifications: {enabled: true}, autostart: false}).ok).toBe(true);
    });

    it('accepts an empty object', () => {
        expect(checkJsonSettings({}).ok).toBe(true);
    });

    it('rejects a non-object root', () => {
        expect(checkJsonSettings('nope')).toMatchObject({ok: false, reason: 'not-an-object'});
        expect(checkJsonSettings(42)).toMatchObject({ok: false, reason: 'not-an-object'});
        expect(checkJsonSettings(null)).toMatchObject({ok: false, reason: 'not-an-object'});
    });

    it('rejects an array root - it is an object to typeof, but not a settings document', () => {
        expect(checkJsonSettings([1, 2, 3])).toMatchObject({ok: false, reason: 'not-an-object'});
    });

    it('rejects a document over the size cap', () => {
        const oversized = {blob: 'x'.repeat(JSON_SETTINGS_MAX_BYTES)};
        expect(checkJsonSettings(oversized)).toMatchObject({ok: false, reason: 'too-large'});
    });

    it('measures utf-8 bytes, not string length', () => {
        // Four bytes each, so a quarter of the cap in characters is the whole cap in bytes.
        const emoji = {blob: '🙂'.repeat(JSON_SETTINGS_MAX_BYTES / 4)};
        expect(checkJsonSettings(emoji)).toMatchObject({ok: false, reason: 'too-large'});
    });

    it('accepts a document just under the cap', () => {
        const padding = JSON_SETTINGS_MAX_BYTES - 32;
        const result = checkJsonSettings({blob: 'x'.repeat(padding)});
        expect(result.ok).toBe(true);
        expect(result.bytes).toBeLessThanOrEqual(JSON_SETTINGS_MAX_BYTES);
    });

    it('rejects a document nested past the depth cap', () => {
        let deep: Record<string, unknown> = {};
        const root = deep;
        for (let i = 0; i <= JSON_SETTINGS_MAX_DEPTH + 1; i++) {
            const next = {};
            deep['n'] = next;
            deep = next;
        }
        expect(checkJsonSettings(root)).toMatchObject({ok: false, reason: 'too-deep'});
    });

    it('rejects a cyclic document instead of throwing', () => {
        const cyclic: Record<string, unknown> = {};
        cyclic['self'] = cyclic;
        expect(checkJsonSettings(cyclic)).toMatchObject({ok: false, reason: 'not-serializable'});
    });

    it('reports the encoded size of an accepted document', () => {
        const result = checkJsonSettings({a: 1});
        expect(result.bytes).toBe(JSON.stringify({a: 1}).length);
    });
});
