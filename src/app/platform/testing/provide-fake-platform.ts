import {Provider} from '@angular/core';
import {PlatformHost} from '../host';
import {PlatformCapabilities, tauriCapabilities, webCapabilities} from '../capabilities';
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
import {FakeAutostart} from './fake-autostart';
import {FakeCryptoEngine} from './fake-crypto-engine';
import {FakeDeepLinks} from './fake-deep-links';
import {FakeFileSaver} from './fake-file-saver';
import {FakeHotkeys} from './fake-hotkeys';
import {FakeLinkOpener} from './fake-link-opener';
import {FakeMediaDeviceSource} from './fake-media-devices';
import {FakeMlsEngine} from './fake-mls-engine';
import {FakeMlsLocalStoreFactory} from './fake-mls-local-store';
import {FakeNotifier} from './fake-notifier';
import {FakeOsInfo} from './fake-os-info';
import {FakePresence} from './fake-presence';
import {FakePresenceCatalog} from './fake-presence-catalog';
import {FakeScreenPublisher} from './fake-screen-publisher';
import {FakeSecureStore} from './fake-secure-store';
import {FakeSettingsStoreFactory} from './fake-settings-store';
import {FakeUpdater} from './fake-updater';
import {FakeVoicePublisher} from './fake-voice-publisher';
import {FakeWindowChrome} from './fake-window-chrome';

/**
 * Which port a spec is supplying itself, keyed by the class it would `inject()`.
 *
 * <p>Keyed by port name rather than taking an array of providers, so the compiler checks that what you
 * hand over actually implements the port you named - `{Notifier: new FakeSecureStore()}` does not
 * compile, and neither does a typo in the key. Each value is typed as the <i>port</i>, so a fake, a
 * partial hand-rolled object cast to it, or a `vi`-driven spy all fit.</p>
 *
 * <p>{@link host} is not a port: it picks the {@link PlatformCapabilities} set and the host shape of every
 * default fake below. Supplying `PlatformCapabilities` directly overrides it for the capability object
 * only, which is what a spec wanting one flag flipped away from a real set should do.</p>
 */
export interface FakePlatformOverrides {
    /**
     * Which host the fakes should describe. `'web'` by default.
     *
     * <p><b>Web is the default because it is the stricter host.</b> A caller that works against the
     * browser shape works on the desktop; the reverse is what this migration exists to fix. A spec
     * asserting desktop-only behaviour asks for `'tauri'` - which is also what lets it stop defining
     * `__TAURI_INTERNALS__` on `globalThis` to fake the host, a trick several specs used and that
     * `platform-boundary.spec.ts` counts as a breach everywhere but a spec file.</p>
     */
    host?: PlatformHost;

    PlatformCapabilities?: PlatformCapabilities;
    Autostart?: Autostart;
    CryptoEngine?: CryptoEngine;
    DeepLinks?: DeepLinks;
    FileSaver?: FileSaver;
    Hotkeys?: Hotkeys;
    LinkOpener?: LinkOpener;
    MediaDeviceSource?: MediaDeviceSource;
    MlsEngine?: MlsEngine;
    MlsLocalStoreFactory?: MlsLocalStoreFactory;
    Notifier?: Notifier;
    OsInfo?: OsInfo;
    Presence?: Presence;
    PresenceCatalog?: PresenceCatalog;
    ScreenPublisher?: ScreenPublisher;
    SecureStore?: SecureStore;
    SettingsStoreFactory?: SettingsStoreFactory;
    Updater?: Updater;
    VoicePublisher?: VoicePublisher;
    WindowChrome?: WindowChrome;
}

/**
 * Every platform port, bound to an inert fake, for a TestBed.
 *
 * <p><b>Why this exists.</b> The ports have no `providedIn: 'root'` default - they are provided by
 * `providePlatform()` from `app.config.ts`, which no spec runs - so any spec whose injector graph
 * *transitively* reaches one fails with `NG0201: No provider found for <Port>`. That failure lands on
 * specs with no interest in the port at all: `call-session.service.spec.ts` died on `Autostart` through
 * `CallSessionService -> VoiceWebsocketService -> RealtimeConnectionService -> NotificationService ->
 * UserSettingsService`, and six component specs died on `MlsEngine` through `UserService`. This is one
 * line that ends that whole class of breakage, and it keeps ending it as services acquire new ports.</p>
 *
 * <pre>
 * TestBed.configureTestingModule({providers: [provideFakePlatform()]});
 *
 * // A spec that *is* about a port supplies its own, and keeps the rest:
 * const notifier = new FakeNotifier();
 * TestBed.configureTestingModule({providers: [provideFakePlatform({Notifier: notifier})]});
 *
 * // Or reaches for the default it was given:
 * const store = TestBed.inject(SecureStore) as FakeSecureStore;
 *
 * // Desktop-only behaviour, without defining __TAURI_INTERNALS__ on globalThis:
 * TestBed.configureTestingModule({providers: [provideFakePlatform({host: 'tauri'})]});
 * </pre>
 *
 * <p><b>Every fake is inert:</b> no network, no timers, no `getUserMedia`, no OS shortcut registration, no
 * DOM listener. Reads answer with what is true of a fake and writes record instead of throwing - the one
 * exception being where a port's own contract says a write must reject, and each fake exposes that as a
 * one-line field rather than as a default.</p>
 *
 * <p>Each port is bound with `useFactory`, not `useValue`: the factory runs once per injector, so a
 * `provideFakePlatform()` evaluated at module scope still hands every test its own fakes rather than one
 * shared instance quietly accumulating state across the file.</p>
 *
 * <p>Returns a plain provider array rather than `EnvironmentProviders`, so it also works in a component's
 * own `providers` and in `TestBed.overrideComponent`. Angular flattens nested arrays, so it drops straight
 * into `providers: [...]`.</p>
 */
export function provideFakePlatform(overrides: FakePlatformOverrides = {}): Provider[] {
    const host = overrides.host ?? 'web';
    const tauri = host === 'tauri';

    return [
        {
            provide: PlatformCapabilities,
            useFactory: (): PlatformCapabilities =>
                overrides.PlatformCapabilities ?? (tauri ? tauriCapabilities() : webCapabilities()),
        },

        // ── Desktop-only ports ───────────────────────────────────────────────
        // `supported` follows the host, so a spec that asked for the browser gets fakes that agree with
        // the capability set it was given. None of them rejects a write by default: the web adapters do,
        // and that is asserted where it belongs, in `platform/web/desktop-only.web.spec.ts`.
        port(Autostart, overrides.Autostart, () => {
            const fake = new FakeAutostart();
            fake.supported = tauri;
            return fake;
        }),
        port(Updater, overrides.Updater, () => {
            const fake = new FakeUpdater();
            fake.supported = tauri;
            return fake;
        }),
        port(WindowChrome, overrides.WindowChrome, () => {
            const fake = new FakeWindowChrome();
            fake.supported = tauri;
            return fake;
        }),
        port(Presence, overrides.Presence, () => {
            const fake = new FakePresence();
            fake.supported = tauri;
            return fake;
        }),
        port(PresenceCatalog, overrides.PresenceCatalog, () => {
            const fake = new FakePresenceCatalog();
            fake.supported = tauri;
            return fake;
        }),

        // ── Storage ──────────────────────────────────────────────────────────
        // `hardwareBacked` follows the host because the key-backup UI renders a warning off it, and a
        // fake that always claimed a keychain would make that warning untestable.
        port(SecureStore, overrides.SecureStore, () => {
            const fake = new FakeSecureStore();
            fake.hardwareBacked = tauri;
            return fake;
        }),
        port(SettingsStoreFactory, overrides.SettingsStoreFactory, () => new FakeSettingsStoreFactory()),
        port(MlsLocalStoreFactory, overrides.MlsLocalStoreFactory, () => new FakeMlsLocalStoreFactory()),

        // ── Shell ────────────────────────────────────────────────────────────
        // `produceEagerly` follows the host: the browser has no point at which a destination is known, so
        // it produces the bytes first. Getting that ordering from the host rather than from a default is
        // what makes a `saveLazy` caller's spec mean something on both.
        port(FileSaver, overrides.FileSaver, () => {
            const fake = new FakeFileSaver();
            fake.produceEagerly = !tauri;
            return fake;
        }),
        port(LinkOpener, overrides.LinkOpener, () => new FakeLinkOpener()),
        port(OsInfo, overrides.OsInfo, () => (tauri ? new FakeOsInfo() : new FakeOsInfo('web'))),
        port(DeepLinks, overrides.DeepLinks, () => new FakeDeepLinks()),

        // ── Notifications ────────────────────────────────────────────────────
        // The web host mints no push token at all - `WebNotifier.pushToken()` is null while a service
        // worker, VAPID keys and a server that accepts a third token kind are all missing - and the token
        // *kind* is still `WebPush`. Both halves matter: `UserTokenService` treats null as "nothing to
        // register", and a fake answering `Fcm`/null would exercise a combination no host produces.
        port(Notifier, overrides.Notifier, () => {
            const fake = new FakeNotifier();
            if (!tauri) {
                fake.kind = 'WebPush';
                fake.token = null;
            }
            return fake;
        }),

        // ── Hotkeys ──────────────────────────────────────────────────────────
        // `global` false on web is the whole point of that port: no web API fires while the tab is
        // unfocused, which is precisely the case push-to-talk exists for.
        port(Hotkeys, overrides.Hotkeys, () => {
            const fake = new FakeHotkeys();
            fake.global = tauri;
            return fake;
        }),

        // ── Media ────────────────────────────────────────────────────────────
        // No devices by default on either host. A fake has no hardware, and "nothing is plugged in" is
        // the branch a settings page is least likely to have been written for; `withDefaults()` is the
        // one-liner for an ordinary machine.
        port(MediaDeviceSource, overrides.MediaDeviceSource, () => new FakeMediaDeviceSource()),
        port(VoicePublisher, overrides.VoicePublisher, () => {
            const fake = new FakeVoicePublisher();
            fake.supportsVad = !tauri;
            return fake;
        }),
        port(ScreenPublisher, overrides.ScreenPublisher, () => {
            const fake = new FakeScreenPublisher();
            fake.hasSourcePicker = tauri;
            return fake;
        }),

        // ── Crypto ───────────────────────────────────────────────────────────
        // `MlsEngine.available` stays true on both: `e2ee` is true on both hosts now that the engine
        // cross-compiles to wasm32, and a fake that reported otherwise would have callers taking the
        // "never encrypted here" path, which for a registry read is a cleartext downgrade.
        port(MlsEngine, overrides.MlsEngine, () => new FakeMlsEngine()),
        port(CryptoEngine, overrides.CryptoEngine, () => new FakeCryptoEngine()),
    ];
}

/**
 * One port provider: the override if there is one, otherwise a fresh fake per injector.
 *
 * <p>The generic ties the override to the port token, so the type error for a mismatched pair is
 * reported at the {@link FakePlatformOverrides} key rather than inside this file.</p>
 */
function port<T>(
    token: abstract new (...args: never[]) => T,
    override: T | undefined,
    make: () => T,
): Provider {
    return {provide: token, useFactory: (): T => override ?? make()};
}
