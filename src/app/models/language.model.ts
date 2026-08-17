export interface AppLanguage {
    /** BCP-47 code. Doubles as the file name under `assets/i18n/locales`. */
    code: string;
    /** Endonym, shown as-is in the picker, so it reads the same whatever the current language is. */
    label: string;
}

/** The languages that actually have a locale file in the locales submodule. */
export const SUPPORTED_LANGUAGES: readonly AppLanguage[] = [
    {code: 'en', label: 'English'},
    {code: 'de', label: 'Deutsch'},
    {code: 'fr', label: 'Français'},
];

export const DEFAULT_LANGUAGE = 'en';

export const LANGUAGE_STORAGE_KEY = 'alpine-language';

/**
 * Maps anything language-shaped onto a code we ship, or null if we ship nothing for it.
 * Regional tags collapse to their base ("de-CH" to "de"); the locale files are language-level.
 */
export function matchLanguage(candidate: string | null | undefined): string | null {
    if (!candidate) return null;

    const base = candidate.toLowerCase().split(/[-_]/)[0];

    return SUPPORTED_LANGUAGES.some(l => l.code === base) ? base : null;
}

/** {@link matchLanguage} for callers that need an answer either way, boot mostly. */
export function resolveLanguage(candidate: string | null | undefined): string {
    return matchLanguage(candidate) ?? DEFAULT_LANGUAGE;
}

/** The language to boot with, resolved without the injector: this runs before any service exists. */
export function storedLanguage(): string {
    let saved: string | null = null;
    try {
        saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    } catch {
        // Private-mode / storage-disabled: fall through to the browser preference.
    }

    return resolveLanguage(saved ?? navigator.language);
}
