import {TestBed} from '@angular/core/testing';
import {Router} from '@angular/router';
import {provideTranslateService, TranslateLoader, TranslateService} from '@ngx-translate/core';
import {Observable, of, Subject} from 'rxjs';

import {TitlebarComponent} from './titlebar.component';
import {InboxService} from '../services/inbox.service';
import {ConversationUtilsService} from '../services/conversation-utils.service';
import {ApiConfigService} from '../services/api-config.service';

const GERMAN = {'TITLEBAR.HELP_KEYBINDS': 'Tastenkürzel', 'TITLEBAR.HELP_ABOUT': 'Über Venta'};

/**
 * A language file that has not arrived yet.
 *
 * <p>This is the whole point of the test. The titlebar is built during bootstrap, so English is
 * still in flight when its menu labels are first read - and that is the exact window in which
 * `TranslateService.instant` answers with the key itself. Holding the load open is what lets the
 * component be created in that state rather than after it.</p>
 */
class DeferredLoader implements TranslateLoader {
    readonly english = new Subject<Record<string, string>>();

    getTranslation(lang: string): Observable<Record<string, string>> {
        return lang === 'en' ? this.english.asObservable() : of(lang === 'de' ? GERMAN : {});
    }
}

const store = new Map<string, string>();

beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, String(v)),
            removeItem: (k: string) => void store.delete(k),
            clear: () => store.clear(),
        },
    });
});

function setup() {
    const loader = new DeferredLoader();
    store.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [TitlebarComponent],
        providers: [
            // Mirrors app.config.ts. `fallbackLang` rather than the deprecated `defaultLanguage`,
            // and deliberately no `lang`: nothing in this app calls `use()`, so the fallback load
            // is the only one that ever runs and `onLangChange` never fires on its own.
            provideTranslateService({
                fallbackLang: 'en',
                loader: {provide: TranslateLoader, useValue: loader},
            }),
            {provide: Router, useValue: {url: '/overview', events: new Subject()}},
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test'}},
            {provide: ConversationUtilsService, useValue: {getChatTitle: () => 'Someone'}},
            {
                provide: InboxService,
                useValue: {entries: () => [], totalMentions: () => 0, primeReadState: () => undefined},
            },
        ],
    });

    const fixture = TestBed.createComponent(TitlebarComponent);
    // Deliberately created *before* the loader answers - the ordering that produced the bug.
    fixture.detectChanges();
    const component = fixture.componentInstance as never as {helpItems: () => {label?: string}[]};
    return {fixture, loader, component, labels: () => component.helpItems().map(i => i.label)};
}

describe('TitlebarComponent help menu labels', () => {
    it('does not fall back to the raw key while the language file is in flight', () => {
        const {labels} = setup();
        expect(labels()).not.toContain('TITLEBAR.HELP_KEYBINDS');
        expect(labels()).not.toContain('TITLEBAR.HELP_ABOUT');
    });

    it('picks the labels up once the language file arrives', () => {
        const {fixture, loader, labels} = setup();
        // Read first, which is what the real render does and what a plain `computed` over
        // `instant` would cache forever. Asserting only after the load would pass either way.
        labels();

        loader.english.next({
            'TITLEBAR.HELP_KEYBINDS': 'Keyboard Shortcuts',
            'TITLEBAR.HELP_ABOUT': 'About Venta',
        });
        loader.english.complete();
        fixture.detectChanges();

        expect(labels()).toEqual(['Keyboard Shortcuts', 'About Venta']);
    });

    it('follows a language switch', () => {
        const {fixture, loader, labels} = setup();
        loader.english.next({
            'TITLEBAR.HELP_KEYBINDS': 'Keyboard Shortcuts',
            'TITLEBAR.HELP_ABOUT': 'About Venta',
        });
        loader.english.complete();
        fixture.detectChanges();

        TestBed.inject(TranslateService).use('de');
        fixture.detectChanges();

        expect(labels()).toEqual(['Tastenkürzel', 'Über Venta']);
    });
});

/**
 * The bar is only drawn under Tauri, and `ngOnInit` refuses to set that flag without
 * `__TAURI_INTERNALS__` on the window. Flipping the signal by hand is what renders the chrome
 * without pretending a whole Tauri runtime exists.
 */
function chrome() {
    const {fixture} = setup();
    const instance = fixture.componentInstance as never as {
        isTauri: {set(value: boolean): void};
        toggleMaximize(): void;
    };
    instance.isTauri.set(true);
    fixture.detectChanges();
    const bar = (fixture.nativeElement as HTMLElement).querySelector('.titlebar') as HTMLElement;
    return {fixture, instance, bar};
}

describe('TitlebarComponent double-click to maximize', () => {
    it('leaves it to the drag region rather than toggling a second time', () => {
        const {instance, bar} = chrome();
        // Tauri's injected drag script already invokes `internal_toggle_maximize` on the
        // *mousedown* of a double click. A `(dblclick)` binding on top of it is a second toggle,
        // which restores the window and then puts it straight back.
        const toggle = vi.spyOn(instance, 'toggleMaximize').mockImplementation(() => undefined);

        bar.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, detail: 2}));

        expect(toggle).not.toHaveBeenCalled();
    });

    it('marks the whole bar as a drag region so non-controls still count', () => {
        const {bar} = chrome();
        // Without the handler, only what Tauri recognises drags or maximizes - and a bare
        // attribute means "direct hits on this element only", which the logo and the gaps
        // between buttons are not.
        expect(bar.getAttribute('data-tauri-drag-region')).toBe('deep');
    });
});
