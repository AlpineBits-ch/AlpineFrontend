import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {describe, expect, it} from 'vitest';
import en from '../assets/i18n/locales/en.json';
import {ENTITLEMENT_KEY_NAME_KEYS, ENTITLEMENT_TRANSLATION_KEYS} from './core/entitlement-message';
import {VOICE_LIMIT_TRANSLATION_KEYS} from './core/voice-limits';

/**
 * Every `'SOME.KEY' | translate` in the app resolves to a string in en.json.
 *
 * <p>A key with no entry does not fail, warn or fall back - ngx-translate renders the key itself,
 * so the user reads "CALL.CONNECTED_COUNT" where a sentence should be. That shipped: a key was
 * renamed in the locale file and two templates kept asking for the old name, and nothing between
 * the edit and the running app said a word about it.</p>
 *
 * <p>en.json only. de.json and fr.json are deliberately partial and fall back to English.</p>
 */

const SOURCE_ROOT = join(__dirname);

/** Matches a literal key piped to translate: `'A.B' | translate`, in templates or in TS. */
const STATIC_KEY = /'([A-Z][A-Z0-9_]*(?:\.[A-Z0-9_]+)+)'\s*\|\s*translate/g;

/**
 * The other half of the app's translation, and until now the unguarded half:
 * `this.translate.instant('A.B')`, which is how every service and every toast asks for a string.
 * There are more of these than there are pipes, and a missing one renders exactly the same raw key.
 */
const INSTANT_KEY = /\binstant\(\s*'([A-Z][A-Z0-9_]*(?:\.[A-Z0-9_]+)+)'/g;

const PATTERNS = [STATIC_KEY, INSTANT_KEY];

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...sourceFiles(full));
        else if (/\.(html|ts)$/.test(entry.name) && !entry.name.endsWith('.spec.ts')) out.push(full);
    }
    return out;
}

describe('translation keys', () => {
    it('are all present in en.json', () => {
        const strings = en as Record<string, string>;
        const missing: string[] = [];

        for (const file of sourceFiles(SOURCE_ROOT)) {
            const source = readFileSync(file, 'utf8');
            for (const pattern of PATTERNS) {
                for (const [, key] of source.matchAll(pattern)) {
                    if (!(key in strings)) missing.push(`${key}  (${relative(SOURCE_ROOT, file)})`);
                }
            }
        }

        expect(missing, `keys used in templates but absent from en.json:\n${missing.join('\n')}`)
            .toEqual([]);
    });

    it('finds keys at all, so a broken pattern cannot pass as a clean sweep', () => {
        // Without this the regex could stop matching after a syntax change and the check above
        // would go green having inspected nothing.
        const found = sourceFiles(SOURCE_ROOT)
            .flatMap(f => [...readFileSync(f, 'utf8').matchAll(STATIC_KEY)].map(m => m[1]));

        expect(found.length).toBeGreaterThan(100);
        expect(found).toContain('CALL.PARTICIPANT_COUNT');
    });

    it('finds instant() keys too', () => {
        const found = sourceFiles(SOURCE_ROOT)
            .flatMap(f => [...readFileSync(f, 'utf8').matchAll(INSTANT_KEY)].map(m => m[1]));

        expect(found.length).toBeGreaterThan(100);
        expect(found).toContain('VOICE.JOIN_FAILED');
    });

    /**
     * The keys neither pattern can reach.
     *
     * <p>Entitlement reason and remedy codes are a closed server vocabulary, and the code is the
     * lookup into a table of translation keys. Written the obvious way - `'ENTITLEMENT.REASON.' +
     * code` - the key is computed, matches no pattern here, and renders raw to a user with every
     * test in this file green. So the table holds literals and exports them, and this asserts the
     * export.</p>
     */
    it('resolves every key held in a lookup table', () => {
        const strings = en as Record<string, string>;
        const missing = ENTITLEMENT_TRANSLATION_KEYS.filter(key => !(key in strings));

        expect(ENTITLEMENT_TRANSLATION_KEYS.length).toBeGreaterThan(10);
        expect(missing, `keys held in a table but absent from en.json:\n${missing.join('\n')}`)
            .toEqual([]);
    });

    /**
     * The same, for what a voice room says about its own limits.
     *
     * <p>Held in a table for the same reason and reachable by neither pattern above: the key is
     * chosen by catalogue key at runtime and rendered through a binding, so `'VOICE.DEGRADED.' + x`
     * would render raw to a user in a call with every test in this file green.</p>
     */
    it('resolves every voice limit key', () => {
        const strings = en as Record<string, string>;
        const missing = VOICE_LIMIT_TRANSLATION_KEYS.filter(key => !(key in strings));

        expect(VOICE_LIMIT_TRANSLATION_KEYS.length).toBeGreaterThan(3);
        expect(missing, `voice limit keys absent from en.json:\n${missing.join('\n')}`).toEqual([]);
    });

    /**
     * No two catalogue keys wear the same label.
     *
     * <p>The plan comparison table draws one row per key, so two keys sharing a label are two rows
     * a reader cannot tell apart. That shipped: `storage.upload_max_bytes` and
     * `user.upload_max_bytes` were both "Upload size", and the table showed the row twice with the
     * same figure because the plan seed happened to set both to the same bytes. They are not
     * duplicates - one is the paired ceiling on uploads into a guild, the other is the user-scoped
     * one for direct messages - so the day the two values diverge the duplicate stops being merely
     * redundant and starts being wrong.</p>
     *
     * <p>Asserted on the rendered <b>strings</b> rather than on the key names, because the mistake
     * is made in the locale file and not in the table.</p>
     */
    it('gives no two entitlement keys the same label', () => {
        const strings = en as Record<string, string>;
        const byLabel = new Map<string, string[]>();

        for (const [catalogueKey, translationKey] of Object.entries(ENTITLEMENT_KEY_NAME_KEYS)) {
            const label = strings[translationKey];
            if (label === undefined) continue;
            byLabel.set(label, [...(byLabel.get(label) ?? []), catalogueKey]);
        }

        const collisions = [...byLabel.entries()]
            .filter(([, keys]) => keys.length > 1)
            .map(([label, keys]) => `"${label}" is the label for ${keys.join(' and ')}`);

        expect(Object.keys(ENTITLEMENT_KEY_NAME_KEYS).length).toBeGreaterThan(5);
        expect(collisions, `entitlement keys sharing one label:\n${collisions.join('\n')}`)
            .toEqual([]);
    });
});
