import {EnvironmentProviders, makeEnvironmentProviders} from '@angular/core';
import {detectHost} from './host';
import {PlatformCapabilities, tauriCapabilities, webCapabilities} from './capabilities';
import {Autostart} from './ports/autostart.port';
import {TauriAutostart} from './tauri/autostart.tauri';
import {WebAutostart} from './web/autostart.web';
import {CryptoEngine} from './ports/crypto-engine.port';
import {TauriCryptoEngine} from './tauri/crypto-engine.tauri';
import {WebCryptoEngine} from './web/crypto-engine.web';
import {DeepLinks} from './ports/deep-links.port';
import {TauriDeepLinks} from './tauri/deep-links.tauri';
import {WebDeepLinks} from './web/deep-links.web';
import {FileSaver} from './ports/file-saver.port';
import {TauriFileSaver} from './tauri/file-saver.tauri';
import {WebFileSaver} from './web/file-saver.web';
import {Hotkeys} from './ports/hotkeys.port';
import {TauriHotkeys} from './tauri/hotkeys.tauri';
import {WebHotkeys} from './web/hotkeys.web';
import {LinkOpener} from './ports/link-opener.port';
import {TauriLinkOpener} from './tauri/link-opener.tauri';
import {WebLinkOpener} from './web/link-opener.web';
import {MediaDeviceSource} from './ports/media-devices.port';
import {createMediaDeviceSource} from './media-device-source-factory';
import {MlsEngine} from './ports/mls-engine.port';
import {TauriMlsEngine} from './tauri/mls-engine.tauri';
import {WebMlsEngine} from './web/mls-engine.web';
import {MlsLocalStoreFactory} from './ports/mls-local-store.port';
import {TauriMlsLocalStoreFactory} from './tauri/mls-local-store.tauri';
import {WebMlsLocalStoreFactory} from './web/mls-local-store.web';
import {Notifier} from './ports/notifier.port';
import {OsInfo} from './ports/os-info.port';
import {TauriOsInfo} from './tauri/os-info.tauri';
import {WebOsInfo} from './web/os-info.web';
import {Presence} from './ports/presence.port';
import {TauriPresence} from './tauri/presence.tauri';
import {WebPresence} from './web/presence.web';
import {PresenceCatalog} from './ports/presence-catalog.port';
import {TauriPresenceCatalog} from './tauri/presence-catalog.tauri';
import {WebPresenceCatalog} from './web/presence-catalog.web';
import {ScreenPublisher} from './ports/screen-publisher.port';
import {screenPublisherFor} from './screen-publisher.factory';
import {SecureStore} from './ports/secure-store.port';
import {SettingsStoreFactory} from './ports/settings-store.port';
import {Updater} from './ports/updater.port';
import {TauriUpdater} from './tauri/updater.tauri';
import {WebUpdater} from './web/updater.web';
import {VoicePublisher} from './ports/voice-publisher.port';
import {TauriVoicePublisher} from './tauri/voice-publisher.tauri';
import {WebVoicePublisher} from './web/voice-publisher.web';
import {WindowChrome} from './ports/window-chrome.port';
import {TauriWindowChrome} from './tauri/window-chrome.tauri';
import {WebWindowChrome} from './web/window-chrome.web';
import {createSecureStore} from './secure-store-factory';
import {createSettingsStoreFactory} from './settings-store-factory';
// Adapters. Static class references with lazily-`import()`ed host dependencies inside.
import {TauriNotifier} from './tauri/notifier.tauri';
import {WebNotifier} from './web/notifier.web';

/**
 * The platform layer, chosen once from {@link detectHost}. Called once from `app.config.ts`.
 *
 * Nothing outside `src/app/platform/` may select an adapter or import `@tauri-apps/*`,
 * `tauri-plugin-*` or `@choochmeque/*`; `platform-boundary.spec.ts` asserts it. Adapters must
 * `import()` their host dependencies on first call, never at construction.
 */
export function providePlatform(): EnvironmentProviders {
    const host = detectHost();

    return makeEnvironmentProviders([
        // ── PlatformCapabilities ──────────────────────────────────────────────
        // Provided eagerly: templates read it before anything else has been wired.
        {
            provide: PlatformCapabilities,
            useFactory: () => (host === 'tauri' ? tauriCapabilities() : webCapabilities()),
        },

        // ── SecureStore ───────────────────────────────────────────────────────
        // Tauri: the OS keychain, through tauri-plugin-secure-storage, `hardwareBacked = true`.
        // Web: IndexedDB, `hardwareBacked = false`; it rejects rather than falling back to anything weaker.
        {provide: SecureStore, useFactory: () => createSecureStore(host)},

        // ── SettingsStoreFactory ──────────────────────────────────────────────
        // Tauri: one `LazyStore` per open, plugin imported on first call. Web: `localStorage`.
        {provide: SettingsStoreFactory, useFactory: () => createSettingsStoreFactory(host)},

        // ── FileSaver ─────────────────────────────────────────────────────────
        // tauri: plugin-dialog + plugin-fs, web: a Blob and an `<a download>`.
        {
            provide: FileSaver,
            useFactory: (): FileSaver => (host === 'tauri' ? new TauriFileSaver() : new WebFileSaver()),
        },

        // ── LinkOpener ────────────────────────────────────────────────────────
        // tauri: plugin-opener (a navigation would replace the app), web: a new tab with `noopener`.
        {
            provide: LinkOpener,
            useFactory: (): LinkOpener => (host === 'tauri' ? new TauriLinkOpener() : new WebLinkOpener()),
        },

        // ── OsInfo ────────────────────────────────────────────────────────────
        // tauri: the OS plugin's injected global + api/app over IPC, web: navigator + package.json.
        // Neither adapter may throw while being constructed, so this is safe in a field initialiser.
        {
            provide: OsInfo,
            useFactory: (): OsInfo => (host === 'tauri' ? new TauriOsInfo() : new WebOsInfo()),
        },

        // ── DeepLinks ─────────────────────────────────────────────────────────
        // tauri: plugin-deep-link, web: nothing to deliver, since the address bar is the launch URL.
        {
            provide: DeepLinks,
            useFactory: (): DeepLinks => (host === 'tauri' ? new TauriDeepLinks() : new WebDeepLinks()),
        },

        // ── Notifier ──────────────────────────────────────────────────────────
        // WIRED BY: notifications track (tauri: @choochmeque plugin, web: Notification API)
        // Web shows notifications; it registers for no push, so `pushToken()` returns null.
        {
            provide: Notifier,
            useFactory: () => (host === 'tauri' ? new TauriNotifier() : new WebNotifier()),
        },

        // ── Hotkeys ───────────────────────────────────────────────────────────
        // tauri: plugin-global-shortcut (imported inside `bind`) plus the Windows PTT hook, both
        // booleans true. Web: `keydown` in the capture phase, `global = false`.
        // `TauriHotkeys` also implements `NativePttHook`, which `NativePttService` probes for.
        {
            provide: Hotkeys,
            useFactory: (): Hotkeys => (host === 'tauri' ? new TauriHotkeys() : new WebHotkeys()),
        },

        // ── MediaDeviceSource ─────────────────────────────────────────────────
        // Tauri: the three `enumerate_*_devices` commands. Web: one `enumerateDevices()` split by kind.
        {provide: MediaDeviceSource, useFactory: () => createMediaDeviceSource(host)},

        // ── VoicePublisher ────────────────────────────────────────────────────
        // Tauri: the Rust voice engine's 14 `voice_*` commands. Web: `getUserMedia`, one
        // `RTCPeerConnection` per publication against the same SFU, and a Web Audio mixer for playout.
        {
            provide: VoicePublisher,
            useFactory: (): VoicePublisher =>
                host === 'tauri' ? new TauriVoicePublisher() : new WebVoicePublisher(),
        },

        // ── ScreenPublisher ───────────────────────────────────────────────────
        // tauri: the Rust publisher and the canvas capture pipeline behind it.
        // web: getDisplayMedia on a media session of its own. `hasSourcePicker` is false there, so the
        // in-app ScreenPickerComponent is skipped and the host's picker chooses the source.
        {provide: ScreenPublisher, useFactory: () => screenPublisherFor(host)},

        // ── MlsEngine ─────────────────────────────────────────────────────────
        // WIRED BY: crypto-wasm track (tauri: invoke, web: venta-crypto wasm-bindgen)
        // `MlsState::save_to_disk` is a no-op on wasm32, so the web adapter keeps a sealed exported
        // blob in IndexedDB and holds an exclusive Web Lock per account scope. Desktop takes no lock.
        {
            provide: MlsEngine,
            useFactory: (): MlsEngine => (host === 'tauri' ? new TauriMlsEngine() : new WebMlsEngine()),
        },

        // ── CryptoEngine ──────────────────────────────────────────────────────
        // WIRED BY: crypto-wasm track (tauri: invoke, web: venta-crypto wasm-bindgen)
        // No `available` flag and nothing to persist; both hosts run the same Rust.
        {
            provide: CryptoEngine,
            useFactory: (): CryptoEngine =>
                host === 'tauri' ? new TauriCryptoEngine() : new WebCryptoEngine(),
        },

        // ── MlsLocalStoreFactory ──────────────────────────────────────────────
        // WIRED BY: crypto-wasm track (tauri: LazyStore, web: IndexedDB)
        // MLS's two per-account files: the group registry and the plaintext message cache. Its own
        // port rather than `SettingsStoreFactory` because both files need enumeration.
        {
            provide: MlsLocalStoreFactory,
            useFactory: (): MlsLocalStoreFactory =>
                host === 'tauri' ? new TauriMlsLocalStoreFactory() : new WebMlsLocalStoreFactory(),
        },

        // ── WindowChrome ──────────────────────────────────────────────────────
        // WIRED BY: desktop-only track (web: no-op, supported = false)
        // Rule for the five desktop-only blocks below: the web adapter answers reads with the true
        // "nothing here" value and rejects writes.
        {
            provide: WindowChrome,
            useFactory: () => (host === 'tauri' ? new TauriWindowChrome() : new WebWindowChrome()),
        },

        // ── Presence ──────────────────────────────────────────────────────────
        // WIRED BY: desktop-only track (web: no-op, supported = false)
        {provide: Presence, useFactory: () => (host === 'tauri' ? new TauriPresence() : new WebPresence())},

        // ── PresenceCatalog ───────────────────────────────────────────────────
        // WIRED BY: desktop-only track (web: no-op, supported = false)
        // `presence_catalog_state` and `presence_load_catalog`: a cache handshake over Rust's on-disk catalog.
        {
            provide: PresenceCatalog,
            useFactory: () => (host === 'tauri' ? new TauriPresenceCatalog() : new WebPresenceCatalog()),
        },

        // ── Updater ───────────────────────────────────────────────────────────
        // WIRED BY: desktop-only track (web: no-op, supported = false)
        // The web adapter rejects `check()` rather than resolving null.
        {provide: Updater, useFactory: () => (host === 'tauri' ? new TauriUpdater() : new WebUpdater())},

        // ── Autostart ─────────────────────────────────────────────────────────
        // WIRED BY: desktop-only track (web: no-op, supported = false)
        {
            provide: Autostart,
            useFactory: () => (host === 'tauri' ? new TauriAutostart() : new WebAutostart()),
        },
    ]);
}
