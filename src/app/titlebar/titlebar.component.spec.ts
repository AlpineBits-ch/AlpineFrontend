import {computed, signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {Router} from '@angular/router';
import {provideTranslateService, TranslateLoader, TranslateService} from '@ngx-translate/core';
import {Observable, of, Subject} from 'rxjs';

import defaultCapability from '../../../src-tauri/capabilities/default.json';
import {TitlebarComponent} from './titlebar.component';
import {InboxService} from '../services/inbox.service';
import {IdentityWebsocketService} from '../services/identity-websocket.service';
import {ConversationUtilsService} from '../services/conversation-utils.service';
import {ApiConfigService} from '../services/api-config.service';
import {WindowChrome} from '../platform/ports/window-chrome.port';
import {FakeWindowChrome} from '../platform/testing/fake-window-chrome';

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

/** Everything the titlebar and the inbox panel it renders read off the service. */
type InboxSurface = Pick<InboxService,
    | 'badgeLabel' | 'open'
    | 'summary' | 'unread' | 'mentions' | 'tasks' | 'channelGlyph'
    | 'unreadLoading' | 'unreadHasMore' | 'unreadFailed'
    | 'mentionsLoading' | 'mentionsHasMore' | 'mentionsFailed'
    | 'tasksLoading' | 'tasksFailed' | 'tasksTruncated'
    | 'previewsUnavailable'>;

/**
 * An inbox holding nothing.
 *
 * <p><b>Typed against the real service on purpose.</b> The previous stub described a surface the
 * inbox had before its panel was extracted - `entries`, `totalMentions`, `primeReadState`, none of
 * which exist any more - and nothing said so. A stale `useValue` does not fail where it is wrong:
 * it fails wherever the template first touches a missing member, which here was the two
 * double-click-to-maximize tests, neither of which has anything to do with the inbox. `Pick` turns
 * the next such drift into a compile error in this file instead.</p>
 */
function inboxStub(): InboxSurface {
    return {
        badgeLabel: computed(() => null),
        open: () => undefined,
        summary: signal({
            unreadChannelCount: 0,
            mentionCount: 0,
            taskCount: 0,
            capped: false,
        }).asReadonly(),
        unread: signal([]).asReadonly(),
        mentions: signal([]).asReadonly(),
        tasks: signal([]).asReadonly(),
        channelGlyph: () => '#',
        unreadLoading: signal(false),
        unreadHasMore: signal(false),
        unreadFailed: signal(false),
        mentionsLoading: signal(false),
        mentionsHasMore: signal(false),
        mentionsFailed: signal(false),
        tasksLoading: signal(false),
        tasksFailed: signal(false),
        tasksTruncated: signal(false),
        previewsUnavailable: signal(false),
    };
}

/**
 * A host with no window frame - which is what a bare TestBed is, and what a browser is.
 *
 * <p>`supported = false` is what `ngOnInit` reads, so this keeps the bar undrawn by default exactly as
 * the `__TAURI_INTERNALS__` check did. The one describe that needs the chrome rendered flips the signal
 * by hand instead of flipping this - see {@link chrome} below.</p>
 */
let windowChrome: FakeWindowChrome;

function setup() {
    const loader = new DeferredLoader();
    windowChrome = new FakeWindowChrome();
    windowChrome.supported = false;
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
            {provide: InboxService, useValue: inboxStub()},
            // Injected by the titlebar purely so its `identity.*` handlers get registered once at
            // bootstrap; nothing in this component reads it. Stubbed for the same reason the inbox
            // is - the real one reaches the shared SignalR connection, and through it `OAuthService`,
            // which none of these tests are about.
            {provide: IdentityWebsocketService, useValue: {}},
            {provide: WindowChrome, useValue: windowChrome},
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
 * The bar is only drawn where the app owns its window frame, and `ngOnInit` refuses to set that flag
 * unless `WindowChrome.supported` says so. Flipping the signal by hand is what renders the chrome
 * without pretending a whole Tauri runtime exists - still the right shape after the port migration: a
 * `supported: true` fake would additionally have to answer `isMaximized` and `onResized` for the async
 * half of `ngOnInit`, and none of these tests are about either.
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

describe('close button permissions', () => {
    /**
     * The close button was a no-op for a whole release and nothing said why.
     *
     * <p>Tauri calls `api.prevent_close()` for any window that has a JS `tauri://close-requested`
     * listener and then leaves it to the JS wrapper to finish the job with `destroy()`.
     * {@link RichPresenceService} registers such a listener as soon as the app shell mounts, so
     * from that moment `destroy` - not `close` - is what actually shuts the window. It was never
     * granted, the invoke was rejected by the ACL inside an event callback nobody was reading, and
     * the button silently did nothing until the listener tore itself down and a second click got
     * through natively.</p>
     */
    it('grants destroy as well as close', () => {
        expect(defaultCapability.permissions).toContain('core:window:allow-close');
        expect(defaultCapability.permissions).toContain('core:window:allow-destroy');
    });
});

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
