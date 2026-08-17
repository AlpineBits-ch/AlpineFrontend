import * as fs from 'node:fs';
import * as path from 'node:path';
import {ProviderToken} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {PlatformCapabilities} from '../capabilities';
import {Autostart} from '../ports/autostart.port';
import {CryptoEngine} from '../ports/crypto-engine.port';
import {DeepLinks} from '../ports/deep-links.port';
import {FileSaver} from '../ports/file-saver.port';
import {Hotkeys} from '../ports/hotkeys.port';
import {LinkOpener} from '../ports/link-opener.port';
import {MediaDeviceSource} from '../ports/media-devices.port';
import {MlsEngine} from '../ports/mls-engine.port';
import {MlsLocalStoreFactory} from '../ports/mls-local-store.port';
import {Notifier} from '../ports/notifier.port';
import {OsInfo} from '../ports/os-info.port';
import {Presence} from '../ports/presence.port';
import {PresenceCatalog} from '../ports/presence-catalog.port';
import {ScreenPublisher} from '../ports/screen-publisher.port';
import {SecureStore} from '../ports/secure-store.port';
import {SettingsStoreFactory} from '../ports/settings-store.port';
import {Updater} from '../ports/updater.port';
import {VoicePublisher} from '../ports/voice-publisher.port';
import {WindowChrome} from '../ports/window-chrome.port';
import {FakeNotifier} from './fake-notifier';
import {FakeSecureStore} from './fake-secure-store';
import {provideFakePlatform} from './provide-fake-platform';

/**
 * Every port, by the name the class is declared under.
 *
 * <p>Written out rather than derived, so the assertion below compares two independently-produced lists:
 * this one, and the abstract classes actually declared in `../ports/`. A port added to the app and not
 * added here is the failure this file exists to catch - it presents as `NG0201` in some unrelated spec
 * days later, which is the whole reason `provideFakePlatform` was written.</p>
 */
const PORTS: Record<string, ProviderToken<unknown>> = {
    Autostart,
    CryptoEngine,
    DeepLinks,
    FileSaver,
    Hotkeys,
    LinkOpener,
    MediaDeviceSource,
    MlsEngine,
    MlsLocalStoreFactory,
    Notifier,
    OsInfo,
    Presence,
    PresenceCatalog,
    ScreenPublisher,
    SecureStore,
    SettingsStoreFactory,
    Updater,
    VoicePublisher,
    WindowChrome,
};

/** `src/app/platform/ports`, located from this file rather than from a runner's cwd. */
function portsDir(): string {
    // `new URL(...).pathname` is `/C:/Users/...` on Windows; the drive letter has to come first for
    // `path` to treat it as absolute. Same reasoning as `platform-boundary.spec.ts`.
    const pathname = decodeURIComponent(new URL(import.meta.url).pathname);
    return path.join(path.dirname(pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'ports');
}

/** Every abstract class exported from `ports/`, which is exactly the set of DI tokens. */
function declaredPortNames(): string[] {
    const dir = portsDir();
    const names: string[] = [];

    for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.port.ts')) continue;
        const source = fs.readFileSync(path.join(dir, entry), 'utf8');
        for (const match of source.matchAll(/export abstract class (\w+)/g)) names.push(match[1]!);
    }

    return names.sort();
}

describe('provideFakePlatform', () => {
    it('provides every port declared in ports/', () => {
        // Guards the guard: an empty read would make the comparison vacuous and this file pointless.
        const declared = declaredPortNames();
        expect(declared.length).toBeGreaterThan(15);

        expect(
            declared,
            'A port exists that provideFakePlatform() does not provide (or vice versa). An unprovided\n' +
                'port surfaces as NG0201 in whichever unrelated spec first reaches it transitively - add a\n' +
                'fake in src/app/platform/testing/ and a line in provide-fake-platform.ts.',
        ).toEqual(Object.keys(PORTS).sort());
    });

    it('resolves every port from a TestBed that provides nothing else', () => {
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({providers: [provideFakePlatform()]});

        for (const [name, token] of Object.entries(PORTS)) {
            expect(TestBed.inject(token), `${name} did not resolve`).toBeTruthy();
        }
    });

    it('defaults to the web capability set, and answers the desktop one on request', () => {
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({providers: [provideFakePlatform()]});
        const web = TestBed.inject(PlatformCapabilities);

        expect(web.host).toBe('web');
        expect(web.globalHotkeys).toBe(false);
        expect(web.hardwareBackedKeys).toBe(false);
        expect(web.voiceActivityDetection).toBe(true);

        TestBed.resetTestingModule();
        TestBed.configureTestingModule({providers: [provideFakePlatform({host: 'tauri'})]});
        const tauri = TestBed.inject(PlatformCapabilities);

        expect(tauri.host).toBe('tauri');
        expect(tauri.globalHotkeys).toBe(true);
        expect(tauri.hardwareBackedKeys).toBe(true);
        expect(tauri.voiceActivityDetection).toBe(false);
    });

    it('shapes the fakes to the host it was asked for, not just the capability flags', () => {
        // The point of `host` is that a spec asserting desktop behaviour need not also define
        // `__TAURI_INTERNALS__` on globalThis: the fakes and the capabilities agree with each other.
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({providers: [provideFakePlatform()]});
        expect(TestBed.inject(SecureStore).hardwareBacked).toBe(false);
        expect(TestBed.inject(Hotkeys).global).toBe(false);
        expect(TestBed.inject(Autostart).supported).toBe(false);
        expect(TestBed.inject(OsInfo).kind).toBe('web');

        TestBed.resetTestingModule();
        TestBed.configureTestingModule({providers: [provideFakePlatform({host: 'tauri'})]});
        expect(TestBed.inject(SecureStore).hardwareBacked).toBe(true);
        expect(TestBed.inject(Hotkeys).global).toBe(true);
        expect(TestBed.inject(Autostart).supported).toBe(true);
        expect(TestBed.inject(OsInfo).kind).toBe('windows');
    });

    it('hands over an overridden port and keeps the defaults for the rest', () => {
        const notifier = new FakeNotifier();

        TestBed.resetTestingModule();
        TestBed.configureTestingModule({providers: [provideFakePlatform({Notifier: notifier})]});

        expect(TestBed.inject(Notifier)).toBe(notifier);
        expect(TestBed.inject(SecureStore)).toBeInstanceOf(FakeSecureStore);
    });

    it('gives each injector its own fakes', async () => {
        // `useFactory`, not `useValue`: a provideFakePlatform() evaluated once at a spec file's module
        // scope must not leave one fake accumulating state across every test in the file.
        const providers = provideFakePlatform();

        TestBed.resetTestingModule();
        TestBed.configureTestingModule({providers: [providers]});
        const first = TestBed.inject(SecureStore) as FakeSecureStore;
        await first.setItem('k', 'v');

        TestBed.resetTestingModule();
        TestBed.configureTestingModule({providers: [providers]});
        const second = TestBed.inject(SecureStore) as FakeSecureStore;

        expect(second).not.toBe(first);
        expect(second.keys()).toEqual([]);
    });
});
