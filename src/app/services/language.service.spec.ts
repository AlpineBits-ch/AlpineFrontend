import {TestBed} from '@angular/core/testing';
import {TranslateService} from '@ngx-translate/core';
import {of} from 'rxjs';
import {beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {LanguageService} from './language.service';
import {LANGUAGE_STORAGE_KEY} from '../models/language.model';

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

/** Records what the service asked of ngx-translate without loading any locale file. */
class FakeTranslate {
    currentLang = 'en';
    readonly registered: string[] = [];
    readonly used: string[] = [];

    addLangs(langs: string[]): void {
        this.registered.push(...langs);
    }

    use(lang: string) {
        this.currentLang = lang;
        this.used.push(lang);
        return of({});
    }
}

function freshService(): {service: LanguageService; translate: FakeTranslate} {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [{provide: TranslateService, useClass: FakeTranslate}],
    });
    return {
        service: TestBed.inject(LanguageService),
        translate: TestBed.inject(TranslateService) as unknown as FakeTranslate,
    };
}

describe('LanguageService', () => {
    beforeEach(() => localStore.clear());

    it('registers every shipped language with ngx-translate', () => {
        const {translate} = freshService();
        expect(translate.registered).toEqual(['en', 'de', 'fr']);
    });

    it('starts on the saved language', () => {
        localStore.set(LANGUAGE_STORAGE_KEY, 'de');
        const {service, translate} = freshService();

        expect(service.current()).toBe('de');
        // provideTranslateService's `lang` is not in play here, so the service has to close the gap.
        expect(translate.used).toEqual(['de']);
    });

    it('does not re-request a language ngx-translate is already on', () => {
        const {translate} = freshService();
        expect(translate.used).toEqual([]);
    });

    it('applies, persists and announces a switch', () => {
        const {service, translate} = freshService();

        service.setLanguage('fr');

        expect(service.current()).toBe('fr');
        expect(translate.used).toEqual(['fr']);
        expect(localStore.get(LANGUAGE_STORAGE_KEY)).toBe('fr');
        expect(document.documentElement.lang).toBe('fr');
    });

    it('collapses a regional tag onto the language we ship', () => {
        const {service} = freshService();

        service.setLanguage('de-CH');

        expect(service.current()).toBe('de');
        expect(localStore.get(LANGUAGE_STORAGE_KEY)).toBe('de');
    });

    it('stays put when asked for a language with no locale file', () => {
        localStore.set(LANGUAGE_STORAGE_KEY, 'de');
        const {service, translate} = freshService();
        translate.used.length = 0;

        service.setLanguage('ja');

        expect(service.current()).toBe('de');
        expect(translate.used).toEqual([]);
    });

    it('ignores a re-pick of the current language', () => {
        const {service, translate} = freshService();

        service.setLanguage('en');

        expect(translate.used).toEqual([]);
    });
});
