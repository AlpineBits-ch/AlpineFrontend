export interface AppLanguage {
    /** BCP-47 code. Doubles as the file name under `assets/i18n/locales`. */
    code: string;
    /** Endonym - shown as-is in the picker, so it reads the same whatever the current language is. */
    label: string;
}

/**
 * The languages that actually have a locale file. Adding one here without adding
 * `<code>.json` to the locales submodule gives an entry that loads nothing and falls
 * back to English for every key.
 */
export const SUPPORTED_LANGUAGES: readonly AppLanguage[] = [
    {code: 'en', label: 'English'},
    {code: 'de', label: 'Deutsch'},
    {code: 'fr', label: 'Français'},
];

export const DEFAULT_LANGUAGE = 'en';

export const LANGUAGE_STORAGE_KEY = 'alpine-language';

/**
 * Maps anything language-shaped onto a code we ship, or null if we ship nothing for it. Regional
 * tags collapse to their base ("de-CH" -> "de") because the locale files are language-level, and
 * the stored value from an older build could be one of the "en-us" style tags the picker used to
 * hold.
 */
export function matchLanguage(candidate: string | null | undefined): string | null {
    if (!candidate) return null;

    const base = candidate.toLowerCase().split(/[-_]/)[0];

    return SUPPORTED_LANGUAGES.some(l => l.code === base) ? base : null;
}

/** {@link matchLanguage} for callers that need an answer either way - boot, mostly. */
export function resolveLanguage(candidate: string | null | undefined): string {
    return matchLanguage(candidate) ?? DEFAULT_LANGUAGE;
}

/**
 * The language to boot with, resolved without the injector: this runs while
 * {@link https://ngx-translate.org | TranslateService} is still being provided, before anything
 * can inject a service to ask.
 */
export function storedLanguage(): string {
    let saved: string | null = null;
    try {
        saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    } catch {
        // Private-mode / storage-disabled: fall through to the browser preference.
    }

    return resolveLanguage(saved ?? navigator.language);
}
