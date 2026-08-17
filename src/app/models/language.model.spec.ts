import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {
    DEFAULT_LANGUAGE,
    LANGUAGE_STORAGE_KEY,
    matchLanguage,
    resolveLanguage,
    storedLanguage,
    SUPPORTED_LANGUAGES,
} from './language.model';

describe('matchLanguage', () => {
    it('answers null for empty input', () => {
        expect(matchLanguage(null)).toBeNull();
        expect(matchLanguage(undefined)).toBeNull();
        expect(matchLanguage('')).toBeNull();
    });

    it('answers null for a language we ship no locale for', () => {
        expect(matchLanguage('ja')).toBeNull();
        expect(matchLanguage('it-IT')).toBeNull();
    });

    it('collapses a regional tag onto the base language', () => {
        expect(matchLanguage('de-CH')).toBe('de');
        expect(matchLanguage('fr_CA')).toBe('fr');
        expect(matchLanguage('EN-GB')).toBe('en');
    });
});

describe('resolveLanguage', () => {
    it('falls back to English for empty input', () => {
        expect(resolveLanguage(null)).toBe(DEFAULT_LANGUAGE);
        expect(resolveLanguage(undefined)).toBe(DEFAULT_LANGUAGE);
        expect(resolveLanguage('')).toBe(DEFAULT_LANGUAGE);
    });

    it('passes through a supported code', () => {
        expect(resolveLanguage('de')).toBe('de');
        expect(resolveLanguage('fr')).toBe('fr');
    });

    it('collapses a regional tag onto the base language', () => {
        expect(resolveLanguage('de-CH')).toBe('de');
        expect(resolveLanguage('fr_CA')).toBe('fr');
        expect(resolveLanguage('EN-GB')).toBe('en');
    });

    it('maps the "en-us" value older builds stored back onto English', () => {
        expect(resolveLanguage('en-us')).toBe('en');
    });

    it('falls back to English for a language we ship no locale for', () => {
        expect(resolveLanguage('ja')).toBe(DEFAULT_LANGUAGE);
        expect(resolveLanguage('it-IT')).toBe(DEFAULT_LANGUAGE);
    });

    it('resolves every supported code to itself', () => {
        for (const lang of SUPPORTED_LANGUAGES) {
            expect(resolveLanguage(lang.code)).toBe(lang.code);
        }
    });
});

/** This runner's `localStorage` global carries no methods, so reads and writes need a stand-in. */
const localStore = new Map<string, string>();

beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => localStore.get(k) ?? null,
            setItem: (k: string, v: string) => void localStore.set(k, String(v)),
            removeItem: (k: string) => void localStore.delete(k),
            clear: () => localStore.clear(),
        },
    });
});

describe('storedLanguage', () => {
    afterEach(() => localStore.clear());

    it('prefers the saved choice', () => {
        localStorage.setItem(LANGUAGE_STORAGE_KEY, 'fr');
        expect(storedLanguage()).toBe('fr');
    });

    it('ignores a saved value we no longer ship', () => {
        localStorage.setItem(LANGUAGE_STORAGE_KEY, 'ja');
        expect(storedLanguage()).toBe(DEFAULT_LANGUAGE);
    });

    it('falls back to the browser preference when nothing is saved', () => {
        const spy = vi.spyOn(navigator, 'language', 'get').mockReturnValue('de-DE');
        expect(storedLanguage()).toBe('de');
        spy.mockRestore();
    });
});
