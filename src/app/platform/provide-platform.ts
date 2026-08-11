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
// Adapters. Static class references with lazily-`import()`ed host dependencies inside: a provider
// factory is synchronous, so it is the plugin (or the WASM blob) that loads on first call, not the
// adapter module. Each track adds its own line here as it wires its port.
import {TauriNotifier} from './tauri/notifier.tauri';
import {WebNotifier} from './web/notifier.web';

/**
 * Placeholder for a port whose adapters have not been written yet.
 *
 * <p>Throws on <b>first injection</b>, not at bootstrap, because the factory is what runs lazily.
 * That is the point: the scaffold can land and the app keeps booting, and each port fails loudly and
 * by name the moment something actually reaches for it. A no-op stub would have been quieter and
 * far worse - the failure would surface as a feature that silently does nothing, which is the exact
 * bug class the capability rules exist to prevent.</p>
 */
function notWired(port: string): never {
    throw new Error(`${port} adapter not yet wired`);
}

/**
 * The platform layer, chosen once from {@link detectHost}.
 *
 * <p>Called once from `app.config.ts`. Nothing outside `src/app/platform/` selects an adapter, and
 * nothing outside it imports `@tauri-apps/*`, `tauri-plugin-*` or `@choochmeque/*` - see
 * `platform-boundary.spec.ts`, which asserts that rather than trusting it.</p>
 *
 * <p><b>Each port owns one contiguous block below, marked `WIRED BY`.</b> That layout is deliberate:
 * the tracks filling these in land in parallel, and one provider per block means two tracks touching
 * two different ports never touch the same lines. Replace the `notWired` factory with a
 * `useFactory` that `import()`s the adapter for the detected host - <b>on first call, not at
 * construction</b>, so the desktop build never downloads the WASM blob and the web build never pulls
 * a Tauri plugin.</p>
 */
export function providePlatform(): EnvironmentProviders {
    const host = detectHost();

    return makeEnvironmentProviders([
        // ── PlatformCapabilities ──────────────────────────────────────────────
        // Provided eagerly rather than via an adapter: it is the one thing here that has to answer
        // before anything has been wired, because templates read it to decide what to render.
        {
            provide: PlatformCapabilities,
            useFactory: () => (host === 'tauri' ? tauriCapabilities() : webCapabilities()),
        },

        // ── SecureStore ───────────────────────────────────────────────────────
        // Tauri: the OS keychain, through tauri-plugin-secure-storage, `hardwareBacked = true`.
        // Web: IndexedDB, `hardwareBacked = false`, and it rejects rather than falling back to
        // anything weaker - a caller storing a master key must be able to tell that nothing was
        // persisted. See the Security posture section of the design spec.
        {provide: SecureStore, useFactory: () => createSecureStore(host)},

        // ── SettingsStoreFactory ──────────────────────────────────────────────
        // Tauri: one `LazyStore` per open, plugin imported on first call. Web: `localStorage`.
        // `openSettingsStore()` in services/settings-store.ts calls the same factory function, so
        // the two entry points cannot disagree about the host while its other callers migrate.
        {provide: SettingsStoreFactory, useFactory: () => createSettingsStoreFactory(host)},

        // ── FileSaver ─────────────────────────────────────────────────────────
        // tauri: plugin-dialog + plugin-fs, web: a Blob and an `<a download>`.
        // The adapter classes are imported statically and their plugins are not: each `import()`s
        // `@tauri-apps/plugin-*` inside `save()`, so a browser client never fetches one.
        {
            provide: FileSaver,
            useFactory: (): FileSaver =>
                host === 'tauri' ? new TauriFileSaver() : new WebFileSaver(),
        },

        // ── LinkOpener ────────────────────────────────────────────────────────
        // tauri: plugin-opener (a navigation would replace the app), web: a new tab with `noopener`.
        {
            provide: LinkOpener,
            useFactory: (): LinkOpener =>
                host === 'tauri' ? new TauriLinkOpener() : new WebLinkOpener(),
        },

        // ── OsInfo ────────────────────────────────────────────────────────────
        // tauri: the OS plugin's injected global + api/app over IPC, web: navigator + package.json.
        // Safe to inject from a field initialiser, which `PlatformService` was not: neither adapter
        // can throw while being constructed, which is the failure `PlatformService` documents at
        // length - a `TypeError` there took route activation for `/overview` down with it.
        {
            provide: OsInfo,
            useFactory: (): OsInfo => (host === 'tauri' ? new TauriOsInfo() : new WebOsInfo()),
        },

        // ── DeepLinks ─────────────────────────────────────────────────────────
        // tauri: plugin-deep-link, web: nothing to deliver - the address bar is the launch URL.
        {
            provide: DeepLinks,
            useFactory: (): DeepLinks =>
                host === 'tauri' ? new TauriDeepLinks() : new WebDeepLinks(),
        },

        // ── Notifier ──────────────────────────────────────────────────────────
        // WIRED BY: notifications track (tauri: @choochmeque plugin, web: Notification API)
        // Web *shows* notifications; it registers for no push. `WebNotifier.pushToken()` returns null
        // and documents the three missing pieces - a service worker, VAPID keys, and a server that
        // accepts a third token kind. `UserTokenService` treats null as "nothing to register".
        {
            provide: Notifier,
            useFactory: () => (host === 'tauri' ? new TauriNotifier() : new WebNotifier()),
        },

        // ── Hotkeys ───────────────────────────────────────────────────────────
        // tauri: plugin-global-shortcut (imported inside `bind`) plus the Windows PTT hook, both
        // booleans true. Web: `keydown` in the capture phase, `global = false` - no web API fires while
        // the tab is unfocused, so a keybind here reaches only as far as Alpine's own focus and voice
        // activity detection is the substitute for the case PTT exists for.
        // `TauriHotkeys` also implements `NativePttHook`; `NativePttService` probes for it, which is
        // what makes its `supported()` false on web with no host check in the service.
        {
            provide: Hotkeys,
            useFactory: (): Hotkeys => (host === 'tauri' ? new TauriHotkeys() : new WebHotkeys()),
        },

        // ── MediaDeviceSource ─────────────────────────────────────────────────
        // Tauri: the three `enumerate_*_devices` commands, `@tauri-apps/api/core` imported on first
        // call. Web: one `enumerateDevices()` split by kind, with two honest caveats - labels are
        // blank until the page holds a media permission (numbered stand-ins, flagged, never blank),
        // and outputs are neither enumerable nor selectable without `setSinkId`. Both caveats reach
        // the UI through `MediaDeviceCatalogService.namesWithheld` / `.outputSupport`.
        {provide: MediaDeviceSource, useFactory: () => createMediaDeviceSource(host)},

        // ── VoicePublisher ────────────────────────────────────────────────────
        // Tauri: the Rust voice engine's 14 `voice_*` commands. Web: a real publisher -
        // `getUserMedia`, one `RTCPeerConnection` per publication against the same SFU, and a Web
        // Audio mixer for playout, because on that host there is no Rust mixer to receive into.
        //
        // Constructed in the factory rather than injected as classes of their own, so this stays one
        // provider like every other block here. The web adapter's `inject()`ed dependencies - HttpClient,
        // the voice-activity gate, the device resolver - and the `effect()` it opens both resolve fine:
        // a `useFactory` body *is* an injection context, and one scoped to the environment injector, so
        // the effect lives exactly as long as the adapter does.
        //
        // Neither touches a device or a network until something calls it. The Tauri one `import()`s the
        // IPC module on first use, so a browser build never pulls it into its startup path.
        {
            provide: VoicePublisher,
            useFactory: (): VoicePublisher =>
                host === 'tauri' ? new TauriVoicePublisher() : new WebVoicePublisher(),
        },

        // ── ScreenPublisher ───────────────────────────────────────────────────
        // tauri: the Rust publisher and the canvas capture pipeline behind it.
        // web: getDisplayMedia published on a media session of its own, which supersedes the canvas
        // pipeline outright - no JPEG round trip. `hasSourcePicker` is false there, so the in-app
        // ScreenPickerComponent is skipped and the host's picker chooses the source; the preset chooser
        // still applies and geometry is still solved by `solveGeometry`.
        {provide: ScreenPublisher, useFactory: () => screenPublisherFor(host)},

        // ── MlsEngine ─────────────────────────────────────────────────────────
        // WIRED BY: crypto-wasm track (tauri: invoke, web: venta-crypto wasm-bindgen)
        // The web adapter carries the one divergence this port has: `MlsState::save_to_disk` is a no-op
        // on wasm32, so it calls `mls_export_state` after every mutating command and keeps the sealed
        // blob in IndexedDB, restoring it through `mls_import_state` on `mls_init_storage`. Without
        // that, a group join or a merged commit is lost on refresh with nothing reporting it.
        // `available` is false only once loading the module has actually failed - not while it is still
        // loading - because `MlsService` answers registry reads with "never encrypted here" when it is
        // false, and that answer during a boot is a §L.9 cleartext downgrade.
        {
            provide: MlsEngine,
            useFactory: (): MlsEngine =>
                host === 'tauri' ? new TauriMlsEngine() : new WebMlsEngine(),
        },

        // ── CryptoEngine ──────────────────────────────────────────────────────
        // WIRED BY: crypto-wasm track (tauri: invoke, web: venta-crypto wasm-bindgen)
        // No `available` flag and nothing to persist: these eight commands take their inputs and return
        // their outputs, and both hosts run the same Rust, verified against venta-mobile's golden
        // vectors on `wasm32` by `parity_tests.rs`.
        {
            provide: CryptoEngine,
            useFactory: (): CryptoEngine =>
                host === 'tauri' ? new TauriCryptoEngine() : new WebCryptoEngine(),
        },

        // ── MlsLocalStoreFactory ──────────────────────────────────────────────
        // WIRED BY: crypto-wasm track (tauri: LazyStore, web: IndexedDB)
        // MLS's two per-account files - the group registry and the plaintext message cache. Its own port
        // rather than `SettingsStoreFactory` because both files need enumeration: the §D export dumps the
        // whole registry, the cache is pruned by age across every entry, and a wipe clears both
        // wholesale. `SettingsStore` is deliberately four methods with no `entries()`/`clear()`, and its
        // web adapter ignores the file name - one flat `localStorage` namespace - so a `clear()` routed
        // through it would take the account registry and the device ids with it. Widening that interface
        // and scoping its browser adapter per file would delete this port; see its header.
        {
            provide: MlsLocalStoreFactory,
            useFactory: (): MlsLocalStoreFactory => host === 'tauri'
                ? new TauriMlsLocalStoreFactory()
                : new WebMlsLocalStoreFactory(),
        },

        // ── WindowChrome ──────────────────────────────────────────────────────
        // WIRED BY: desktop-only track (web: no-op, supported = false)
        // The five desktop-only blocks below all follow the same rule: the web adapter answers *reads*
        // with the true "nothing here" value and *rejects* writes, because a resolved write is
        // indistinguishable from having done the work. See each web adapter's header.
        {
            provide: WindowChrome,
            useFactory: () => (host === 'tauri' ? new TauriWindowChrome() : new WebWindowChrome()),
        },

        // ── Presence ──────────────────────────────────────────────────────────
        // WIRED BY: desktop-only track (web: no-op, supported = false)
        {provide: Presence, useFactory: () => (host === 'tauri' ? new TauriPresence() : new WebPresence())},

        // ── PresenceCatalog ───────────────────────────────────────────────────
        // WIRED BY: desktop-only track (web: no-op, supported = false)
        // Added by that track rather than listed in the design spec: `GameCatalogService` invokes two
        // commands (`presence_catalog_state`, `presence_load_catalog`) that are a cache handshake over
        // Rust's on-disk catalog, not part of "what is this machine doing". See the port's own note on
        // why they are not two more methods on `Presence`.
        {
            provide: PresenceCatalog,
            useFactory: () => (host === 'tauri' ? new TauriPresenceCatalog() : new WebPresenceCatalog()),
        },

        // ── Updater ───────────────────────────────────────────────────────────
        // WIRED BY: desktop-only track (web: no-op, supported = false)
        // Note the web adapter *rejects* `check()` rather than resolving null: "already up to date" is
        // indistinguishable from a successful check and would hide a stale client forever.
        {provide: Updater, useFactory: () => (host === 'tauri' ? new TauriUpdater() : new WebUpdater())},

        // ── Autostart ─────────────────────────────────────────────────────────
        // WIRED BY: desktop-only track (web: no-op, supported = false)
        {provide: Autostart, useFactory: () => (host === 'tauri' ? new TauriAutostart() : new WebAutostart())},
    ]);
}
