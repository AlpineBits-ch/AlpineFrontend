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

/** A language a member can write in, which is not the same set as the languages the UI ships. */
export interface ContentLanguage {
    /** BCP-47 code. */
    code: string;
    /** Endonym, so a reader recognises their own language whatever the UI is set to. */
    label: string;
    /** English name, so the person choosing can scan a script they do not read. */
    english: string;
}

/**
 * What a listing or a guild can declare it speaks. Deliberately not {@link SUPPORTED_LANGUAGES}:
 * that list is gated on shipping a locale file, and a guild recruits in Polish whether or not the
 * UI does.
 */
export const CONTENT_LANGUAGES: readonly ContentLanguage[] = [
    {code: 'ar', label: 'العربية', english: 'Arabic'},
    {code: 'cs', label: 'Čeština', english: 'Czech'},
    {code: 'da', label: 'Dansk', english: 'Danish'},
    {code: 'de', label: 'Deutsch', english: 'German'},
    {code: 'el', label: 'Ελληνικά', english: 'Greek'},
    {code: 'en', label: 'English', english: 'English'},
    {code: 'es', label: 'Español', english: 'Spanish'},
    {code: 'fi', label: 'Suomi', english: 'Finnish'},
    {code: 'fil', label: 'Filipino', english: 'Filipino'},
    {code: 'fr', label: 'Français', english: 'French'},
    {code: 'he', label: 'עברית', english: 'Hebrew'},
    {code: 'hi', label: 'हिन्दी', english: 'Hindi'},
    {code: 'hu', label: 'Magyar', english: 'Hungarian'},
    {code: 'id', label: 'Bahasa Indonesia', english: 'Indonesian'},
    {code: 'it', label: 'Italiano', english: 'Italian'},
    {code: 'ja', label: '日本語', english: 'Japanese'},
    {code: 'ko', label: '한국어', english: 'Korean'},
    {code: 'nl', label: 'Nederlands', english: 'Dutch'},
    {code: 'no', label: 'Norsk', english: 'Norwegian'},
    {code: 'pl', label: 'Polski', english: 'Polish'},
    {code: 'pt', label: 'Português', english: 'Portuguese'},
    {code: 'pt-BR', label: 'Português (Brasil)', english: 'Portuguese (Brazil)'},
    {code: 'ro', label: 'Română', english: 'Romanian'},
    {code: 'ru', label: 'Русский', english: 'Russian'},
    {code: 'sv', label: 'Svenska', english: 'Swedish'},
    {code: 'th', label: 'ไทย', english: 'Thai'},
    {code: 'tr', label: 'Türkçe', english: 'Turkish'},
    {code: 'uk', label: 'Українська', english: 'Ukrainian'},
    {code: 'vi', label: 'Tiếng Việt', english: 'Vietnamese'},
    {code: 'zh-Hans', label: '简体中文', english: 'Chinese (Simplified)'},
    {code: 'zh-Hant', label: '繁體中文', english: 'Chinese (Traditional)'},
];

/** Falls back to the code itself, so a listing saved with a code we later drop still renders. */
export function contentLanguageLabel(code: string): string {
    return CONTENT_LANGUAGES.find(l => l.code === code)?.label ?? code;
}

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
