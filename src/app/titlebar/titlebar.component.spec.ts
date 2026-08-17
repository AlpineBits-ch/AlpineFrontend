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
import {provideFakePlatform} from '../platform/testing/provide-fake-platform';

const GERMAN = {'TITLEBAR.HELP_KEYBINDS': 'Tastenkürzel', 'TITLEBAR.HELP_ABOUT': 'Über Venta'};

/** A language file that has not arrived yet. */
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

/** An inbox holding nothing. */
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

/** A host with no window frame, which is what a bare TestBed is. */
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
            provideFakePlatform(),
            // Mirrors app.config.ts: `fallbackLang` and no `lang`, since nothing in this app calls `use()`.
            provideTranslateService({
                fallbackLang: 'en',
                loader: {provide: TranslateLoader, useValue: loader},
            }),
            {provide: Router, useValue: {url: '/overview', events: new Subject()}},
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test'}},
            {provide: ConversationUtilsService, useValue: {getChatTitle: () => 'Someone'}},
            {provide: InboxService, useValue: inboxStub()},
            // Injected by the titlebar only to register its `identity.*` handlers; nothing reads it.
            {provide: IdentityWebsocketService, useValue: {}},
            {provide: WindowChrome, useValue: windowChrome},
        ],
    });

    const fixture = TestBed.createComponent(TitlebarComponent);
    // Must be created before the loader answers, which is the ordering under test.
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
        // Must read before the load, or the assertion would pass either way.
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

/** Renders the bar by flipping `showChrome` by hand, rather than standing up a Tauri host. */
function chrome() {
    const {fixture} = setup();
    const instance = fixture.componentInstance as never as {
        showChrome: {set(value: boolean): void};
        toggleMaximize(): void;
    };
    instance.showChrome.set(true);
    fixture.detectChanges();
    const bar = (fixture.nativeElement as HTMLElement).querySelector('.titlebar') as HTMLElement;
    return {fixture, instance, bar};
}

describe('close button permissions', () => {
    it('grants destroy as well as close', () => {
        expect(defaultCapability.permissions).toContain('core:window:allow-close');
        expect(defaultCapability.permissions).toContain('core:window:allow-destroy');
    });
});

describe('TitlebarComponent double-click to maximize', () => {
    it('leaves it to the drag region rather than toggling a second time', () => {
        const {instance, bar} = chrome();
        // Tauri's drag script already toggles maximize on mousedown, so a `(dblclick)` binding would double-toggle.
        const toggle = vi.spyOn(instance, 'toggleMaximize').mockImplementation(() => undefined);

        bar.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, detail: 2}));

        expect(toggle).not.toHaveBeenCalled();
    });

    it('marks the whole bar as a drag region so non-controls still count', () => {
        const {bar} = chrome();
        // A bare attribute means direct hits only, which the logo and the gaps between buttons are not.
        expect(bar.getAttribute('data-tauri-drag-region')).toBe('deep');
    });
});
