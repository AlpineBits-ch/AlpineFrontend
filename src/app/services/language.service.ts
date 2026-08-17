import {inject, Injectable, signal} from '@angular/core';
import {TranslateService} from '@ngx-translate/core';
import {
    AppLanguage,
    LANGUAGE_STORAGE_KEY,
    matchLanguage,
    storedLanguage,
    SUPPORTED_LANGUAGES,
} from '../models/language.model';

/**
 * Owns the UI language: which one is active, how it is persisted, and telling
 * `TranslateService` about a change.
 *
 * <p>The choice lives in `localStorage` rather than the server-side settings blob, for the same
 * reason the theme does: it has to be readable before the injector exists so the first paint is
 * already in the right language, and it has to work on the login screen, where there is no account
 * to read settings from yet.</p>
 */
@Injectable({providedIn: 'root'})
export class LanguageService {
    /** Copied out of the readonly constant because `p-select` types its options as mutable. */
    readonly languages: AppLanguage[] = [...SUPPORTED_LANGUAGES];

    private readonly translate = inject(TranslateService);
    private readonly _current = signal(storedLanguage());

    /** Active language code, e.g. `de`. Always one of {@link SUPPORTED_LANGUAGES}. */
    readonly current = this._current.asReadonly();

    constructor() {
        this.translate.addLangs(SUPPORTED_LANGUAGES.map(l => l.code));

        // `provideTranslateService({lang})` already kicked off the initial load with the same
        // value, so only step in if something got there first with a different one.
        if (this.translate.currentLang !== this._current()) {
            this.translate.use(this._current());
        }
        this.reflectOnDocument(this._current());
    }

    /** No-ops for a language we ship no locale for, rather than quietly dropping back to English. */
    setLanguage(code: string): void {
        const resolved = matchLanguage(code);
        if (!resolved || resolved === this._current()) return;

        this._current.set(resolved);
        try {
            localStorage.setItem(LANGUAGE_STORAGE_KEY, resolved);
        } catch {
            // Not persisting is survivable; the switch itself still applies for this session.
        }

        this.reflectOnDocument(resolved);
        this.translate.use(resolved).subscribe({
            error: err => console.error(`Could not load the "${resolved}" locale`, err),
        });
    }

    /** Keeps `<html lang>` truthful, which is what hyphenation, spellcheck and screen readers read. */
    private reflectOnDocument(code: string): void {
        document.documentElement.lang = code;
    }
}
