# Browser-only build — design

Date: 2026-08-11
Status: approved, in implementation

## Goal

Ship the Angular app as a **public web client for real users**, from the same source tree that
builds the Tauri desktop app. Not a demo, not a CI target: someone can sign up in a browser and
use it as their primary client.

Today a browser boot fails outright (`mls.service.ts:226` — "the app happens not to boot in a
browser today"). This design makes it boot, and decides for every native dependency whether it gets
a real browser implementation or an honest "desktop only".

## Decisions

| Question | Decision |
|---|---|
| Audience | Public web client for real users |
| MLS / E2EE | **Cross-compile the Rust engine to WASM.** Full E2EE on web, one engine, no divergence |
| Master key + device certs | Same WASM crate. Byte-identical wrapping, no WebCrypto reimplementation |
| Voice | **Full JS publish path.** `getUserMedia` → `RTCPeerConnection` |
| Screen share | **Full JS publish path.** `getDisplayMedia` |
| Isle PTT | **Voice activity detection (open mic).** Global hotkeys cannot exist in a browser |
| Impossible features | **Capability-gated UI** — hidden, or disabled with a stated reason. Never a dead toggle |
| Architecture | **Full ports (A) everywhere.** Every native touchpoint is a port with two adapters |
| Build | One bundle, runtime host detection, lazy adapter imports. No second Angular target |

### Why WASM rather than "no E2EE on web"

`src-tauri/src/crypto/mls.rs` is already factored for a third host. Its header states it is shared
line-for-line with venta-mobile, that the engine functions take `&str` and mirror mobile's exactly,
and that the `#[tauri::command]` wrappers and `*_impl` shims "live at the bottom, in their own
clearly marked sections". Mobile drives that same engine through a process-global `Mutex` and an
explicit storage path. WASM is a third edge on a seam that already exists twice.

Every crypto dependency is pure RustCrypto — `openmls`, `openmls_rust_crypto`, `aes-gcm`, `sha2`,
`argon2`, `rsa`, `hkdf`, `hmac`. No `ring`, no C, no MSVC-only patches (the vendored
`webrtc-audio-processing-sys` patch is media, not crypto, and does not come along).

Filesystem contact is confined to persistence and is already behind `state_path: Option<PathBuf>`
plus the existing `export_state` / `import_state` pair (encrypted blob in, encrypted blob out). WASM
runs with `state_path: None` and persists that blob to IndexedDB. **No new at-rest format.**

### Why not "no E2EE on web" even as a phase 1

A web session that registers as a device but holds no MLS keys becomes an *unreachable device* that
blocks group adds for desktop members. Avoiding that means web sessions must not register as MLS
devices at all, which is its own branch through device-identity, registration and coverage. Doing
the WASM port is less total work than building and then deleting that branch.

## Architecture — the port layer

`src/app/platform/` becomes the only place in the app that knows a native host exists.

```
src/app/platform/
  host.ts                 detectHost(): 'tauri' | 'web'
  capabilities.ts         PlatformCapabilities
  ports/                  abstract classes — DI token and type in one
  tauri/                  Tauri adapter per port
  web/                    Browser adapter per port
  provide-platform.ts     providePlatform(): EnvironmentProviders
```

Ports are **abstract classes**, so `inject(SecureStore)` works with no separate `InjectionToken`.
`providePlatform()` is called once from `app.config.ts` and selects the adapter set from
`detectHost()`. Each adapter `import()`s its heavy dependency on **first call**, not at
construction — so the desktop build never downloads the WASM blob and the web build never pulls a
Tauri plugin.

### The boundary invariant

**No file outside `src/app/platform/` may import `@tauri-apps/*`, `tauri-plugin-*`, or
`@choochmeque/*`.**

There is no ESLint config in this repo, so this is enforced as an assertion rather than a
convention: `src/app/platform/platform-boundary.spec.ts` walks `src/app` and fails listing every
offender. It starts red with ~35 files and going green *is* the definition of the port work being
finished.

`*.spec.ts` files are exempt while they still mock `isTauri`; the exemption is removed per-file as
each spec moves to a fake adapter.

### Port contracts

Signatures are normative. Adapters implement these exactly; call sites depend on nothing else.

```ts
// host.ts
export type PlatformHost = 'tauri' | 'web';
export function detectHost(): PlatformHost;

// ports/secure-store.port.ts
// Hardware/keychain-backed on desktop; IndexedDB on web (a stated downgrade, see Security).
export abstract class SecureStore {
    abstract getItem(key: string): Promise<string | null>;
    abstract setItem(key: string, value: string): Promise<void>;
    abstract removeItem(key: string): Promise<void>;
    /** Whether this backend is OS-protected. False on web. Drives the UI warning. */
    abstract readonly hardwareBacked: boolean;
}

// ports/settings-store.port.ts — the existing SettingsStore interface, unchanged.
export abstract class SettingsStoreFactory {
    abstract open(file: string): SettingsStore;
}

// ports/file-saver.port.ts
export abstract class FileSaver {
    /** Returns false when the user cancelled. */
    abstract save(suggestedName: string, data: Uint8Array | string, mime?: string): Promise<boolean>;
}

// ports/link-opener.port.ts
export abstract class LinkOpener {
    abstract open(url: string): Promise<void>;
}

// ports/os-info.port.ts
export abstract class OsInfo {
    abstract readonly kind: 'windows' | 'macos' | 'linux' | 'ios' | 'android' | 'web';
    abstract readonly isMobile: boolean;
    abstract appName(): Promise<string>;
    abstract appVersion(): Promise<string>;
}

// ports/deep-links.port.ts
export abstract class DeepLinks {
    /** URL the process was launched with, once. Null on web (the address bar is the launch URL). */
    abstract initial(): Promise<string | null>;
    abstract onOpen(handler: (urls: string[]) => void): Promise<() => void>;
}

// ports/notifier.port.ts
export type PushTokenKind = 'Fcm' | 'ApnsVoip' | 'WebPush';
export abstract class Notifier {
    abstract requestPermission(): Promise<boolean>;
    abstract notify(n: {title: string; body: string; iconUrl?: string; tag?: string}): Promise<void>;
    abstract pushTokenKind(): PushTokenKind | null;
    abstract pushToken(): Promise<string | null>;
    abstract onActivated(handler: (tag: string) => void): Promise<() => void>;
}

// ports/hotkeys.port.ts
export abstract class Hotkeys {
    /** False on web: no API fires while the tab is unfocused. */
    abstract readonly global: boolean;
    /** True on web: keydown works, but only while focused. */
    abstract readonly focused: boolean;
    abstract bind(id: string, accelerator: string, h: {onDown?(): void; onUp?(): void}): Promise<boolean>;
    abstract unbind(id: string): Promise<void>;
    abstract label(accelerator: string): Promise<string>;
    abstract beginCapture(id: string): Promise<void>;
    abstract cancelCapture(): Promise<void>;
}

// ports/media-devices.port.ts
export interface MediaDeviceEntry {id: string; label: string; isDefault: boolean}
export abstract class MediaDeviceSource {
    abstract inputs(): Promise<MediaDeviceEntry[]>;
    abstract outputs(): Promise<MediaDeviceEntry[]>;
    abstract cameras(): Promise<MediaDeviceEntry[]>;
    abstract onChange(handler: () => void): () => void;
}

// ports/voice-publisher.port.ts — mirrors VoiceEngineService's existing surface.
export abstract class VoicePublisher {
    abstract start(o: VoiceStartOptions): Promise<VoiceSession>;
    abstract stop(s: VoiceSession): Promise<void>;
    abstract subscribe(s: VoiceSession, id: string, mediaSessionId: string, trackName: string): Promise<void>;
    abstract unsubscribe(s: VoiceSession, id: string): Promise<void>;
    abstract setPttOpen(s: VoiceSession, open: boolean): Promise<void>;
    abstract setMute(muted: boolean): Promise<void>;
    abstract setDeafened(deafened: boolean): Promise<void>;
    abstract setUserVolume(userId: string, volume: number): Promise<void>;
    abstract setProcessing(p: VoiceProcessing): Promise<void>;
    abstract setSpatialModel(m: SpatialModel): Promise<void>;
    abstract setPosition(p: Position): Promise<void>;
    abstract stats(): Promise<VoiceStats>;
    /** Web-only: VAD replaces PTT because global hotkeys cannot exist. */
    abstract readonly supportsVad: boolean;
}

// ports/screen-publisher.port.ts
export abstract class ScreenPublisher {
    abstract sources(): Promise<ScreenSource[]>;
    abstract thumbnails(ids: string[]): Promise<SourceThumbnail[]>;
    abstract start(o: ScreenPublishOptions): Promise<ScreenPublishResult>;
    abstract stop(shareId: string): Promise<void>;
    abstract setFps(shareId: string, fps: number): Promise<void>;
    abstract setAudioMuted(shareId: string, muted: boolean): Promise<void>;
    /** Web: the OS picker chooses the source, so the in-app picker is skipped. */
    abstract readonly hasSourcePicker: boolean;
}

// ports/mls-engine.port.ts — one method per existing mls_* command, same argument names.
export abstract class MlsEngine {
    abstract call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
    abstract readonly available: boolean;
}

// ports/crypto-engine.port.ts — generate_key_pairs, master key, recovery codes, device certs.
export abstract class CryptoEngine {
    abstract call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

// ports/window-chrome.port.ts, presence.port.ts, updater.port.ts, autostart.port.ts
// Desktop-only. Web adapters are no-ops that report `supported = false`.
```

`MlsEngine` and `CryptoEngine` keep the `call(command, args)` shape rather than 45 named methods.
The command names and argument shapes are already settled and shared with mobile; restating them as
a TypeScript interface would create a second place for them to drift. The adapter routes to Tauri
`invoke` or to wasm-bindgen; callers are unchanged.

### Migration shape: existing services become delegates

A port does **not** replace the service that uses it. `VoiceEngineService`, `RustMediaService`,
`HotkeyService`, `NotificationService` and the rest keep their present public API exactly and become
thin delegates over the injected port.

This is not politeness about churn — it is what keeps the migration parallelisable. `VoiceEngine`'s
consumers include `call-webrtc.service.ts`, `HotkeyService`'s include `call-hotkey.service.ts`, and
those files are owned by other work in flight. Holding the public surface still means the ~60
consumer call sites never enter the diff at all, and each port can land independently without a
cross-cutting rename.

Consumers migrate from the delegate to the port later, opportunistically, or never — a delegate that
forwards one call is not a problem worth a second pass.

### File partition

Each track below owns its files exclusively; no file appears twice, so tracks can run concurrently.

| Track | Files |
|---|---|
| Shell | `external-link.service`, `app-info.service`, `attachment-download.service`, `data-export.service`, `data-export.component`, `theme.service`, `message.component`, `embed-card.component`, `app.component` (deep link) |
| Storage | `device-identity.service`, `ai-credentials.service`, `payment-handle.service`, `settings-store` |
| Notifications | `notification.service`, `user-token.service` |
| Devices | `media-device-catalog.service`, `voice-video-settings.component` |
| Voice | `voice-engine.service`, `isle-voice-rtc.service`, `voice-channel.service` |
| Screen | `rust-media.service`, `screen-publish`, `screen-picker.service` |
| Desktop-only | `update.service`, `user-settings.service`, `window-chrome.service`, `titlebar.component`, `resize-handles.component`, `rich-presence.service`, `game-catalog.service`, `activity-settings.component`, `platform.service`, `device-description` |
| Crypto | `platform/crypto.ts`, `crypto.service`, `master-key.service`, `mls.service` |
| Hotkeys | `hotkey.service`, `native-ptt.service` |

`call-*.ts`, `call-webrtc.service.ts`, `call-session*` and `call-state*` are **off limits** to every
track — other work is live in them, and the delegate rule above means no track needs them.

## Crypto WASM crate

Create a Cargo workspace at the repo root with two members: the existing `src-tauri` and a new
`crates/venta-crypto`.

`crates/venta-crypto` holds `mls.rs`, `crypto.rs` and `device_cert.rs` **moved verbatim** — the
line-for-line correspondence with venta-mobile is load-bearing and must survive. Only the wrapper
sections at the bottom of each file change:

- `#[cfg(feature = "tauri")]` around the `#[tauri::command]` wrappers.
- `#[cfg(target_arch = "wasm32")]` wasm-bindgen wrappers, one per command, taking and returning JSON
  strings so the argument shapes stay identical to the IPC ones.
- `src-tauri` depends on it with `features = ["tauri"]` and re-exports the commands so
  `lib.rs`'s `generate_handler!` list is untouched.

Known wasm32 work items:

1. `getrandom = "0.2"` needs its `js` feature; `uuid` needs `js`. Both gated on `target_arch`.
2. `SystemTime::now()` at `mls.rs:2050` panics on `wasm32-unknown-unknown`. Shim it behind a
   `now_unix_secs()` helper — `SystemTime` on native, `Date.now()` via wasm-bindgen on web.
3. Argon2 is materially slower in wasm. Measure master-key setup and unlock; if unlock exceeds ~2s,
   surface progress rather than weakening parameters. **Do not change Argon2 params** — they are
   part of the at-rest format and desktop must stay able to unwrap what web wrapped.
4. `state_path: None` on wasm. Persistence is `export_state` → IndexedDB, `import_state` on boot.
   The `#floor` monotonic rule and §D envelope semantics are unchanged.
5. Golden-vector tests must run under `wasm32` too (`wasm-bindgen-test`), asserting the web engine
   produces byte-identical output to the native one. This is the test that proves no divergence.

Build: `bun run build:wasm` (`wasm-pack build crates/venta-crypto --target web --release`), emitted
at build time into `src/assets/wasm/` and gitignored — never committed. CI builds it before
`ng build`, and asserts the blob exists, because `ng build` does **not** fail when it is missing (the
asset entry is a `**/*` glob, and a glob matching nothing is not an error) — so the failure would
otherwise surface as a client that dies on the login path.

Measured 2026-08-11: **2.08 MB raw, 771 KiB gzipped**, exporting 37 symbols (the 36 commands plus
`init`), each named identically to its Tauri command.

That size is acceptable but not free, and it lands on the **login path** — unlocking the master key
needs the crypto half. The adapter's lazy `import()` therefore does not defer it past sign-in in
practice; it only keeps the blob out of the desktop bundle. If first-load latency becomes a
complaint, the fix is splitting the crate so master-key unwrapping ships separately from the MLS
group engine, not deferring the load — a spinner on the login button is better than an encrypted
conversation that silently cannot open.

## Media

### Voice publish (web)

`VoicePublisher`'s web adapter is a real WebRTC publisher: `getUserMedia` for the mic,
`RTCPeerConnection` against the same SFU the Rust engine talks to, same `apiBase`/`token`/`deviceId`
contract. Receive already happens in the webview on both hosts and is untouched — see
`project_video_receive_stays_in_webview`.

Echo cancellation, noise suppression and auto-gain come from the browser's own constraints
(`echoCancellation`, `noiseSuppression`, `autoGainControl`) rather than
`webrtc-audio-processing-sys`. `setProcessing` maps onto `applyConstraints`.

Spatial audio needs no work: `spatial-audio.service.ts` is already Web Audio, and the Isle
`refDistance` / `maxDistance` / `rolloffFactor` values in `environment.ts` apply unchanged. The
`CellSize >= maxDistance` invariant is a backend property and is unaffected.

### Voice activity detection

New `VoiceActivityService`: Web Audio `AnalyserNode` on the mic stream, RMS threshold with attack
and hangover windows, driving `setPttOpen`. This is the web substitute for PTT and the only thing
that makes Isle proximity voice usable in a browser while the game has focus.

Thresholds are user-adjustable in voice settings (web only), with a live input meter — a fixed
threshold is unusable across microphones.

### Screen share (web)

`getDisplayMedia` with the OS/browser picker, so `hasSourcePicker = false` and the in-app
`ScreenPickerComponent` is skipped on web; the preset chooser still applies and still solves
geometry through the existing `solveGeometry`. `useRustPublisher()` already returns false outside
Tauri and the canvas path already exists — the web adapter supersedes it with a direct track
publish, which is strictly better (no JPEG round trip).

Screen **audio** capture is Chromium-only and tab/window-scoped. Where unavailable, the share
proceeds video-only and says so.

## Capabilities and UI

`PlatformCapabilities` is a signal-bearing service read directly by templates:

```ts
interface PlatformCapabilities {
    host: PlatformHost;
    globalHotkeys: boolean;     // false on web
    gameDetection: boolean;     // false on web
    richPresence: boolean;      // false on web
    autostart: boolean;         // false on web
    selfUpdate: boolean;        // false on web
    customWindowChrome: boolean;// false on web
    nativeToasts: boolean;      // false on web
    hardwareBackedKeys: boolean;// false on web
    screenSourcePicker: boolean;// false on web
    voiceActivityDetection: boolean; // true on web
    e2ee: boolean;              // true on both, once WASM lands
}
```

Rules:

- A control that cannot work is **hidden** when its absence needs no explanation (window controls,
  the updater page), and **disabled with a one-line reason** when a user would go looking for it
  (Activity/game detection, autostart, global hotkeys).
- No control is left enabled over a no-op. `activity-settings.component.ts:59` already documents
  exactly this bug class and is the precedent.
- The reason strings are i18n keys and go in the locales submodule as their own commit — see
  `project_i18n_locales_submodule`.

## Boot path

Three things hard-block a browser boot and are fixed first, before any port work:

1. `main.ts` calls `getSecureKey()` → `invoke('generate_key')` unguarded at module scope, outside
   the try that wraps the Tauri window reveal. It is a debug `console.log` and is **deleted**.
2. `app.component.ts:23` statically imports `@tauri-apps/plugin-deep-link`. Moves behind the
   `DeepLinks` port.
3. `src/app/platform/crypto.ts` invokes `generate_key` directly. Moves behind `CryptoEngine`.

After that, `main-page.component.ts`'s `runMlsLaunch` must survive an unavailable engine rather than
throwing through boot — relevant only until WASM lands, but it is the difference between a blank
screen and a usable client during the migration.

## Security posture

Stated plainly because a public web client changes the threat model:

- **Signing keys and the master key live in IndexedDB on web, not an OS keychain.** Any XSS on the
  origin can read them. `SecureStore.hardwareBacked` is false on web and the key-backup UI says so.
  `user-token.service.ts:17` already documents this tradeoff for push tokens; the same wording
  extends.
- Web sessions get their own device id like any other device, so a compromised web session is
  revocable per-device without touching desktop sessions.
- Content-Security-Policy on the web deployment must be tight — no inline script, no external
  script hosts — because it is now the primary defence for key material. This is a deployment
  requirement, not optional hardening.

## Backend dependencies

Two things the client cannot finish alone:

1. **Web Push.** `user-token.service.ts:93` mints only `Fcm` / `ApnsVoip`. Web needs a `WebPush`
   token kind, VAPID keys, and a service worker. Server-side contract change; goes in
   `docs/specs/*-frontend-guide.md` per `project_echo_backend_repo`.
2. **CORS and CSP** for the web origin on `api.venta.gg`, including the `/connect/token` endpoint
   the ROPC password flow posts to.
3. **CORS on the data-export storage bucket.** The download endpoint answers 302 to a GCS bucket that
   serves no `Access-Control-Allow-Origin`, so a browser `fetch` of it is blocked — desktop has a
   native download path precisely because that fetch cannot work. Until the bucket sends CORS headers
   (or the API streams the bytes itself), data export must be capability-gated with a reason on web
   rather than offering a button that always fails.
4. **https routes for deep links.** `venta://invite/…`, `install-bot`, `discord-import` and
   `steam-auth` arrive through a custom scheme the browser has no delivery path for. They need
   equivalent https routes before those flows work on web at all.

### Federation on web: self-hosters build their own image

CSP `connect-src` is the primary defence for key material here, so it cannot be a wildcard. But the
client has a federation server picker calling `setServer(domain)`, and a pinned `connect-src` blocks
every host but the official one.

Decided: **the web image takes its allowed API hosts as configuration**, defaulting to the current
tight list. A self-hoster deploys their own web client pointed at their own server — which they are
already doing for the backend, so it adds no new burden. The official image stays as locked down as
it is today, and nobody gets a looser default by accident.

Each configured host derives both its API origin and its websocket origin, because SignalR builds
`${baseUrl}/api/v1/ws/hub` and listing only one is the obvious mistake. A malformed value must fail
the build or `nginx -t`; a CSP directive browsers cannot parse is dropped wholesale and falls back
to `default-src`, which is the failure most likely to go unnoticed.

On the client, the server picker is capability-gated to the configured hosts on web, reading the
same source of truth the image renders its CSP from — not a second hard-coded list.

### Two findings from the web image worth keeping

- Angular's production build emits one inline event handler (Beasties'
  `<link media="print" onload="this.media='all'">`). Under a strict `script-src` it never fires, the
  stylesheet stays `media="print"`, and the app loads with critical CSS only. It is stripped from
  the built `index.html` at package time, with an assertion that no inline handler survives.
- `/assets/**` is **unhashed**. Caching it `immutable` for a year — as the e2e image config did —
  would permanently pin users to a stale crypto engine, since the wasm blob lands there. Hashed
  bundles keep 1y immutable; `/assets/` revalidates.

Auth itself needs no work: `auth.service.ts:42` uses the password grant against `/connect/token`,
a plain POST, and `angular-oauth2-oidc` already stores tokens in browser storage.

## Testing

- `platform-boundary.spec.ts` — the boundary invariant, red until the migration completes.
- Fake adapters for every port, provided in TestBed. Replaces the ten `vi.mock('@tauri-apps/api/core',
  {isTauri: () => true})` blocks.
- Golden-vector parity between native and `wasm32` crypto — the load-bearing test of this design.
- Media tests must mutate what they guard before being trusted; see `project_media_e2e_test_traps`.

## Out of scope

- A second Angular build target. Revisit only if web bundle size becomes a real complaint.
- Porting §G admission proofs or §H.2 certificate issuance to WASM — they have no Alpine caller and
  an unreachable signing surface is worse than an absent one.
- Offline support / service-worker caching beyond what Web Push requires.
- Mobile web layout. The app is desktop-shaped; a phone-sized web client is a separate spec.
