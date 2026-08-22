import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {describe, expect, it} from 'vitest';
import en from '../assets/i18n/locales/en.json';
import {ENTITLEMENT_KEY_NAME_KEYS, ENTITLEMENT_TRANSLATION_KEYS} from './core/entitlement-message';
import {VOICE_LIMIT_TRANSLATION_KEYS} from './core/voice-limits';
import {LISTING_EDITOR_TRANSLATION_KEYS} from './features/discovery/listing-editor/listing-editor.component';
import {WIKI_PUBLISH_STATUS_KEYS} from './features/guild/components/guild-settings-modal/pages/wiki-settings/wiki-settings.component';
import {WIKI_PUBLISH_CONSENT_KEYS} from './features/guild/components/wiki/wiki-publish/wiki-publish-consent.component';

/** Every `'SOME.KEY' | translate` in the app resolves to a string in en.json. en.json only: the others are partial. */

const SOURCE_ROOT = join(__dirname);

/** Matches a literal key piped to translate: `'A.B' | translate`, in templates or in TS. */
const STATIC_KEY = /'([A-Z][A-Z0-9_]*(?:\.[A-Z0-9_]+)+)'\s*\|\s*translate/g;

/** Matches `this.translate.instant('A.B')`, which is how services and toasts ask for a string. */
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

        expect(missing, `keys used in templates but absent from en.json:\n${missing.join('\n')}`).toEqual([]);
    });

    it('finds keys at all, so a broken pattern cannot pass as a clean sweep', () => {
        // Without this the regex could stop matching and the check above would go green having inspected nothing.
        const found = sourceFiles(SOURCE_ROOT).flatMap(f =>
            [...readFileSync(f, 'utf8').matchAll(STATIC_KEY)].map(m => m[1]),
        );

        expect(found.length).toBeGreaterThan(100);
        expect(found).toContain('CALL.PARTICIPANT_COUNT');
    });

    it('finds instant() keys too', () => {
        const found = sourceFiles(SOURCE_ROOT).flatMap(f =>
            [...readFileSync(f, 'utf8').matchAll(INSTANT_KEY)].map(m => m[1]),
        );

        expect(found.length).toBeGreaterThan(100);
        expect(found).toContain('VOICE.JOIN_FAILED');
    });

    /** The entitlement keys neither pattern above can reach, because they are looked up by code. */
    it('resolves every key held in a lookup table', () => {
        const strings = en as Record<string, string>;
        const missing = ENTITLEMENT_TRANSLATION_KEYS.filter(key => !(key in strings));

        expect(ENTITLEMENT_TRANSLATION_KEYS.length).toBeGreaterThan(10);
        expect(missing, `keys held in a table but absent from en.json:\n${missing.join('\n')}`).toEqual([]);
    });

    /** The same, for the wiki publishing sentences, which are chosen by count. */
    it('resolves every wiki publishing status key', () => {
        const strings = en as Record<string, string>;
        const missing = WIKI_PUBLISH_STATUS_KEYS.filter(key => !(key in strings));

        expect(WIKI_PUBLISH_STATUS_KEYS.length).toBeGreaterThan(5);
        expect(missing, `wiki publishing keys absent from en.json:\n${missing.join('\n')}`).toEqual([]);
    });

    /** The same, for the publish dialog's buttons, which are chosen by which step refused. */
    it('resolves every wiki publish consent key', () => {
        const strings = en as Record<string, string>;
        const missing = WIKI_PUBLISH_CONSENT_KEYS.filter(key => !(key in strings));

        expect(WIKI_PUBLISH_CONSENT_KEYS.length).toBeGreaterThan(3);
        expect(missing, `wiki publish consent keys absent from en.json:\n${missing.join('\n')}`).toEqual([]);
    });

    /** The same, for what a voice room says about its own limits. */
    it('resolves every voice limit key', () => {
        const strings = en as Record<string, string>;
        const missing = VOICE_LIMIT_TRANSLATION_KEYS.filter(key => !(key in strings));

        expect(VOICE_LIMIT_TRANSLATION_KEYS.length).toBeGreaterThan(3);
        expect(missing, `voice limit keys absent from en.json:\n${missing.join('\n')}`).toEqual([]);
    });

    /** The same, for a listing's state badge and its suspension reason, both chosen by enum value. */
    it('resolves every listing editor key', () => {
        const strings = en as Record<string, string>;
        const missing = LISTING_EDITOR_TRANSLATION_KEYS.filter(key => !(key in strings));

        expect(LISTING_EDITOR_TRANSLATION_KEYS.length).toBeGreaterThan(3);
        expect(missing, `listing editor keys absent from en.json:\n${missing.join('\n')}`).toEqual([]);
    });

    /** No two catalogue keys wear the same label, or the plan comparison table draws two rows a reader cannot tell apart. */
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
        expect(collisions, `entitlement keys sharing one label:\n${collisions.join('\n')}`).toEqual([]);
    });
});
