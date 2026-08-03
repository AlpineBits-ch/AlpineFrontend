# Device Identity Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send one consistent device identity everywhere the backend now validates or attributes it, adopt every client-facing change in the Device Identity Consolidation guide, and land the multi-device call/voice behaviour that guide presupposes.

**Architecture:** A new `DeviceIdentityService` becomes the single owner of the client device id (the same UUID `MlsService` already persists). An HTTP interceptor stamps `X-Device-Id` on every API request and recovers from the new `400 Unknown X-Device-Id` by re-registering once. The Rust media layer, which issues its own HTTP requests to the Cloudflare session endpoint, sends the same header so the webview and Rust are never seen as two devices. On top of that foundation: push tokens carry their device, login and QR carry the device id, the sessions UI can forget a device, and the call/voice layer gains per-device events.

**Tech Stack:** Angular 21 (signals, functional HTTP interceptors), RxJS, `@microsoft/signalr`, Tauri 2 (`@tauri-apps/plugin-store`, `tauri-plugin-secure-storage-api`), Rust (`reqwest`), Vitest via `@angular/build:unit-test` (globals enabled - no need to import `describe`/`it`/`expect`/`vi`).

## Global Constraints

- Full design context: `docs/superpowers/specs/2026-07-31-device-identity-consolidation-design.md`. Read it before starting.
- **The backend is implemented but NOT deployed.** The `ConsolidateDeviceConcepts` migration has not been applied. Every endpoint here will behave as documented only after deploy. Implement the full contract now; do not gate behind a feature flag.
- **Never generate a second device identifier.** The one and only id is the value at `settings.json` key `mls_device_id`. MLS keychain entries are named `alpine_mls_{deviceId}_{pub|priv|identity}`; a forked id orphans every stored signing key.
- **`ensureRegistered()` must never call `MlsService.generateKeyPackages()`.** That mints a fresh Ed25519 keypair and silently orphans this device from every MLS group it belongs to.
- All API paths go through the gateway base URL from `ApiConfigService.baseUrl()` (a signal - call it). Never hardcode `https://api.venta.gg`.
- Header name is exactly `X-Device-Id`. Hub query param is exactly `deviceId`. Token-request form field is exactly `device_id`. QR-login body field is exactly `clientDeviceId`.
- Toasts in this codebase are **not** translated (see `ToastService`'s own comment and `call-state.service.ts:101`). Use plain English strings in toasts. Only the settings UI uses `| translate`.
- `src/assets/i18n/locales` is a **git submodule** (`git@github.com:AlpineBits-ch/venta-i18n.git`). Locale keys are flat, dot-separated. String changes need their own commit inside the submodule, then a pointer-bump commit in the parent repo.
- Test command: **`bun run ng test --watch=false`**. Not `npx ng test` - dependencies were installed with bun, which writes `.bunx`/`.exe` shims instead of the plain `ng` file npx looks for, so npx fails with "could not determine executable to run". Rust test command: `cargo test --manifest-path src-tauri/Cargo.toml`.
- Baseline before this plan: 68 test files, 796 tests, all passing.
- Do not bulk-edit files with PowerShell 5.1 string replacement: `Get-Content` reads a BOM-less UTF-8 file as ANSI and silently mangles every non-ASCII character. Use the Edit tool, or `[System.IO.File]::ReadAllText` with an explicit `UTF8Encoding($false)`.
- Follow the existing file style: 4-space indent, single quotes, `inject()` over constructor params.

---

## File Structure

**Created:**
- `src/app/services/device-identity.service.ts` - owns the device id and its server registration. Everything else consumes it.
- `src/app/services/device-identity.service.spec.ts`
- `src/app/interceptors/device-id-interceptor.ts` - stamps the header; recovers from `400 Unknown X-Device-Id`.
- `src/app/interceptors/device-id-interceptor.spec.ts`

**Modified:**
- `src/app/services/mls.service.ts` - device-id methods delegate to `DeviceIdentityService`.
- `src/app/services/device.service.ts` - gains `deleteDevice()`.
- `src/app/app.config.ts` - registers the interceptor.
- `src-tauri/src/media/publisher/signalling.rs` - sends `X-Device-Id`.
- `src-tauri/src/media/voice/mod.rs`, `src-tauri/src/media/publisher/mod.rs` - accept `device_id`.
- `src/app/services/voice-engine.service.ts`, `rust-media.service.ts`, `screen-publish.ts`, `voice-rtc.service.ts`, `call-webrtc.service.ts`, `call-session.service.ts` - pass the device id to Rust.
- `src/app/services/realtime-connection.service.ts` - lazy connection with `?deviceId=`.
- `src/app/services/user-token.service.ts` - new push-token endpoint plus deregistration.
- `src/app/features/settings/logout-dialog/logout-dialog.component.ts` - deregisters push on sign-out.
- `src/app/services/auth.service.ts`, `qr-login.service.ts`, `src/app/dtos/request/qr-login.dto.ts` - device id at login.
- `src/app/dtos/response/login-session.dto.ts`, `devices-settings.component.{ts,html}` - sessions UI.
- `src/app/services/voice.service.ts`, `call-session.service.ts`, `call-state.service.ts`, `voice-websocket.service.ts`, `call-webrtc.service.ts`, `guild-websocket.service.ts`, `voice-channel.service.ts`, `call-panel.component.{ts,html}` - multi-device call/voice behaviour.
- `src/assets/i18n/locales/{en,de,fr}.json` - new settings strings (submodule).

---

## Task 1: `DeviceIdentityService` - the device id

**Files:**
- Create: `src/app/services/device-identity.service.ts`
- Create: `src/app/services/device-identity.service.spec.ts`
- Modify: `src/app/services/mls.service.ts:565-585`

**Interfaces:**
- Produces: `DeviceIdentityService.deviceId(): Promise<string>`, `DeviceIdentityService.reset(): Promise<void>`. Every later task consumes `deviceId()`.

- [ ] **Step 1: Write the failing test**

Create `src/app/services/device-identity.service.spec.ts`:

```ts
/**
 * The device id is the single identity the backend now validates. These tests pin the two
 * properties everything else depends on: it is stable across calls, and a transient store
 * failure does not poison the cache for the rest of the session.
 */
vi.mock('@tauri-apps/plugin-store');

import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {LazyStore} from '@tauri-apps/plugin-store';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';

const store = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    save: vi.fn(),
};

beforeEach(() => {
    vi.clearAllMocks();
    store.get.mockResolvedValue({value: 'stored-device-id'});
    store.set.mockResolvedValue(undefined);
    store.delete.mockResolvedValue(undefined);
    store.save.mockResolvedValue(undefined);
    vi.mocked(LazyStore).mockImplementation(() => store as unknown as LazyStore);
});

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.venta.gg'}},
        ],
    });
    return TestBed.inject(DeviceIdentityService);
}

it('returns the id persisted in the store', async () => {
    const service = setup();
    await expect(service.deviceId()).resolves.toBe('stored-device-id');
    expect(store.set).not.toHaveBeenCalled();
});

it('generates and persists an id when the store has none', async () => {
    store.get.mockResolvedValue(null);
    const service = setup();

    const id = await service.deviceId();

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.set).toHaveBeenCalledWith('mls_device_id', {value: id});
    expect(store.save).toHaveBeenCalled();
});

it('reads the store once across repeated calls', async () => {
    const service = setup();

    await Promise.all([service.deviceId(), service.deviceId(), service.deviceId()]);

    expect(store.get).toHaveBeenCalledTimes(1);
});

it('does not cache a failure - a later call retries the store', async () => {
    store.get.mockRejectedValueOnce(new Error('store locked'));
    const service = setup();

    await expect(service.deviceId()).rejects.toThrow('store locked');
    await expect(service.deviceId()).resolves.toBe('stored-device-id');
});

it('reset clears the persisted id and the cache', async () => {
    const service = setup();
    await service.deviceId();

    await service.reset();
    store.get.mockResolvedValue({value: 'regenerated-id'});

    expect(store.delete).toHaveBeenCalledWith('mls_device_id');
    await expect(service.deviceId()).resolves.toBe('regenerated-id');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run ng test --watch=false`
Expected: FAIL - cannot resolve `./device-identity.service`.

- [ ] **Step 3: Create the service**

Create `src/app/services/device-identity.service.ts`:

```ts
import {Injectable} from '@angular/core';
import {LazyStore} from '@tauri-apps/plugin-store';

const STORE_FILE = 'settings.json';
const DEVICE_ID_KEY = 'mls_device_id';

/**
 * Owns this installation's device identity - the id the backend validates as `X-Device-Id`,
 * attributes push tokens to, and links login sessions against.
 *
 * It is deliberately the *same* value MLS already persisted under `mls_device_id`: the MLS
 * keychain entries are named `alpine_mls_{deviceId}_{field}`, so a second identifier would
 * orphan every stored signing key. `MlsService` delegates here rather than keeping its own copy.
 */
@Injectable({providedIn: 'root'})
export class DeviceIdentityService {
    private cached: Promise<string> | null = null;

    /** Stable per-installation id. Resolved from the store once per app session. */
    deviceId(): Promise<string> {
        if (!this.cached) {
            // A rejected promise left in the cache would fail every later caller for the whole
            // session, turning one transient store error into a permanently header-less client.
            this.cached = this.resolve().catch((err: unknown) => {
                this.cached = null;
                throw err;
            });
        }
        return this.cached;
    }

    /** Drops the persisted id so the next {@link deviceId} call mints a fresh one. */
    async reset(): Promise<void> {
        this.cached = null;
        const store = new LazyStore(STORE_FILE);
        await store.delete(DEVICE_ID_KEY);
        await store.save();
    }

    private async resolve(): Promise<string> {
        const store = new LazyStore(STORE_FILE);
        let entry = await store.get<{ value: string }>(DEVICE_ID_KEY);

        if (!entry) {
            entry = {value: crypto.randomUUID()};
            await store.set(DEVICE_ID_KEY, entry);
            await store.save();
        }

        return entry.value;
    }
}
```

- [ ] **Step 4: Make `MlsService` delegate**

In `src/app/services/mls.service.ts`, replace the bodies at lines 565-585 (`getOrCreateDeviceIdentifier` and `deleteDeviceIdentifier`) with delegation. Add `inject` and the service import at the top of the file.

Change the import on line 1 from `import {Injectable, signal} from '@angular/core';` to:

```ts
import {inject, Injectable, signal} from '@angular/core';
```

Add after the other imports:

```ts
import {DeviceIdentityService} from './device-identity.service';
```

Add to the class's field declarations (next to `_groupRegistry` around line 139):

```ts
    private readonly deviceIdentity = inject(DeviceIdentityService);
```

Replace both methods with:

```ts
    /**
     * @deprecated Prefer `DeviceIdentityService.deviceId()`. Kept so existing MLS call sites
     * keep reading the one identifier rather than growing a second one.
     */
    getOrCreateDeviceIdentifier(): Promise<string> {
        return this.deviceIdentity.deviceId();
    }

    deleteDeviceIdentifier(): Promise<void> {
        return this.deviceIdentity.reset();
    }
```

Delete the now-unused `LazyStore` usages only if no other reference remains - lines 139-140 still use it, so keep the import.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run ng test --watch=false`
Expected: PASS - the five new tests plus the existing `mls.service.spec.ts` suite.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/device-identity.service.ts src/app/services/device-identity.service.spec.ts src/app/services/mls.service.ts
git commit -m "feat: give the client device id its own service"
```

---

## Task 2: Device registration and deregistration

**Files:**
- Modify: `src/app/services/device.service.ts`
- Modify: `src/app/services/device-identity.service.ts`
- Modify: `src/app/services/device-identity.service.spec.ts`

**Interfaces:**
- Consumes: `DeviceIdentityService.deviceId()` (Task 1).
- Produces: `DeviceService.deleteDevice(clientDeviceId: string): Observable<void>`; `DeviceIdentityService.ensureRegistered(): Promise<boolean>`; `DeviceIdentityService.unregister(): Observable<void>`. Task 3 consumes `ensureRegistered`; Task 8 consumes `deleteDevice`.

- [ ] **Step 1: Write the failing tests**

Append to `src/app/services/device-identity.service.spec.ts`. Add these imports to the existing import block at the top:

```ts
import {HttpTestingController} from '@angular/common/http/testing';
import {secureStorage} from 'tauri-plugin-secure-storage-api';
```

and add this mock next to the existing `vi.mock('@tauri-apps/plugin-store')` line (module mocks must stay at the top of the file so Vitest hoists them):

```ts
vi.mock('tauri-plugin-secure-storage-api', () => ({
    secureStorage: {getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn()},
}));
```

Then append the tests:

```ts
describe('registration', () => {
    function withHttp() {
        const service = setup();
        return {service, ctrl: TestBed.inject(HttpTestingController)};
    }

    it('re-registers using the stored signing key, never a fresh one', async () => {
        vi.mocked(secureStorage.getItem).mockResolvedValue('stored-public-key');
        const {service, ctrl} = withHttp();

        const result = service.ensureRegistered();

        const req = ctrl.expectOne('https://api.venta.gg/api/v1/identity/devices');
        expect(req.request.method).toBe('POST');
        expect(req.request.body.clientDeviceId).toBe('stored-device-id');
        expect(req.request.body.identityPublicKey).toBe('stored-public-key');
        expect(secureStorage.getItem).toHaveBeenCalledWith('alpine_mls_stored-device-id_pub');
        req.flush({});

        await expect(result).resolves.toBe(true);
    });

    it('reports failure rather than inventing a key when none is stored', async () => {
        vi.mocked(secureStorage.getItem).mockResolvedValue(null);
        const {service, ctrl} = withHttp();

        await expect(service.ensureRegistered()).resolves.toBe(false);

        ctrl.expectNone('https://api.venta.gg/api/v1/identity/devices');
    });

    it('reports failure when the registration request errors', async () => {
        vi.mocked(secureStorage.getItem).mockResolvedValue('stored-public-key');
        const {service, ctrl} = withHttp();

        const result = service.ensureRegistered();
        ctrl.expectOne('https://api.venta.gg/api/v1/identity/devices')
            .flush('nope', {status: 500, statusText: 'Server Error'});

        await expect(result).resolves.toBe(false);
    });

    it('unregisters this device by its client device id', async () => {
        const {service, ctrl} = withHttp();

        service.unregister().subscribe();
        // The url depends on an awaited store read, so let the microtask queue drain first.
        await new Promise<void>(r => setTimeout(r, 0));

        const req = ctrl.expectOne(
            'https://api.venta.gg/api/v1/identity/devices/client/stored-device-id',
        );
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run ng test --watch=false`
Expected: FAIL - `service.ensureRegistered is not a function`.

- [ ] **Step 3: Add the delete endpoint to `DeviceService`**

In `src/app/services/device.service.ts`, add after `registerDevice`:

```ts
    /**
     * Removes the device and, by cascade, its MLS key packages, its encrypted backup and its
     * push tokens; login sessions from that device are revoked. There was no removal path
     * before this, which is why a reinstalled handset kept receiving push forever.
     */
    deleteDevice(clientDeviceId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/client/${encodeURIComponent(clientDeviceId)}`);
    }
```

Note `this.base` is captured at construction from `apiConfig.baseUrl()`; leave that as-is to match `registerDevice`.

- [ ] **Step 4: Add registration to `DeviceIdentityService`**

In `src/app/services/device-identity.service.ts`, replace the `@angular/core` import and add the rest:

```ts
import {inject, Injectable} from '@angular/core';
import {firstValueFrom, from, Observable, switchMap} from 'rxjs';
import {secureStorage} from 'tauri-plugin-secure-storage-api';
import {DeviceService} from './device.service';
import {describeCurrentDevice} from './qr-login.service';
```

Add the field:

```ts
    private readonly devices = inject(DeviceService);
```

Add the methods:

```ts
    /**
     * Idempotently (re)creates this device's server-side record.
     *
     * Deliberately re-registers with the signing key already in secure storage instead of
     * generating a batch: `MlsService.generateKeyPackages` mints a *fresh* Ed25519 keypair, which
     * would silently orphan this device from every MLS group it belongs to. Recovering a deleted
     * device row must not cost the account its message history on this machine.
     *
     * @returns false when it could not register - the caller should fall through to its normal
     *          error path rather than retry. The interactive `DeviceRegistrationModalComponent`
     *          remains the only correct recovery when no signing key is stored at all.
     */
    async ensureRegistered(): Promise<boolean> {
        try {
            const deviceId = await this.deviceId();
            const identityPublicKey = await secureStorage.getItem(`alpine_mls_${deviceId}_pub`);
            if (!identityPublicKey) return false;

            const {deviceName, deviceType} = describeCurrentDevice();
            await firstValueFrom(this.devices.registerDevice({
                clientDeviceId: deviceId,
                deviceName,
                deviceType,
                identityPublicKey,
            }));
            return true;
        } catch (err) {
            console.error('Device re-registration failed', err);
            return false;
        }
    }

    /** "Forget this device" - see {@link DeviceService.deleteDevice} for what this destroys. */
    unregister(): Observable<void> {
        return from(this.deviceId()).pipe(
            switchMap(deviceId => this.devices.deleteDevice(deviceId)),
        );
    }
```

`describeCurrentDevice()` already returns a `deviceType` of the right enum type, so no `DeviceType` import is needed here.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run ng test --watch=false`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/device.service.ts src/app/services/device-identity.service.ts src/app/services/device-identity.service.spec.ts
git commit -m "feat: add device registration recovery and deregistration"
```

---

## Task 3: `X-Device-Id` interceptor with 400 recovery

**Files:**
- Create: `src/app/interceptors/device-id-interceptor.ts`
- Create: `src/app/interceptors/device-id-interceptor.spec.ts`
- Modify: `src/app/app.config.ts:17-19,48`

**Interfaces:**
- Consumes: `DeviceIdentityService.deviceId()`, `.ensureRegistered()` (Tasks 1-2).
- Produces: `deviceIdInterceptor` (an `HttpInterceptorFn`), registered globally.

- [ ] **Step 1: Write the failing test**

Create `src/app/interceptors/device-id-interceptor.spec.ts`:

```ts
/**
 * The header is what the backend now validates, so two things matter: it is always present on
 * API requests, and the new `400 Unknown X-Device-Id` recovers instead of surfacing as a
 * mysterious failure to join a call.
 */
import {HttpClient, provideHttpClient, withInterceptors} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {deviceIdInterceptor} from './device-id-interceptor';
import {DeviceIdentityService} from '../services/device-identity.service';
import {ApiConfigService} from '../services/api-config.service';

const BASE = 'https://api.venta.gg';
const CALL_URL = `${BASE}/api/v1/messaging/voice/call/c1/accept`;
const UNKNOWN_BODY = "Unknown X-Device-Id 'abc' - register the device first.";

function setup() {
    const identity = {
        deviceId: vi.fn(async () => 'device-abc'),
        ensureRegistered: vi.fn(async () => true),
    };

    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(withInterceptors([deviceIdInterceptor])),
            provideHttpClientTesting(),
            {provide: DeviceIdentityService, useValue: identity},
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    });

    return {
        http: TestBed.inject(HttpClient),
        ctrl: TestBed.inject(HttpTestingController),
        identity,
    };
}

function tick() {
    return new Promise<void>(r => setTimeout(r, 0));
}

afterEach(() => TestBed.inject(HttpTestingController).verify());

it('sets X-Device-Id on requests to the API base URL', async () => {
    const {http, ctrl} = setup();

    http.get(CALL_URL).subscribe();
    await tick();

    const req = ctrl.expectOne(CALL_URL);
    expect(req.request.headers.get('X-Device-Id')).toBe('device-abc');
    req.flush({});
});

it('leaves requests outside the API base URL alone', async () => {
    const {http, ctrl, identity} = setup();

    http.get('https://other-service.example/ping').subscribe();
    await tick();

    const req = ctrl.expectOne('https://other-service.example/ping');
    expect(req.request.headers.has('X-Device-Id')).toBe(false);
    expect(identity.deviceId).not.toHaveBeenCalled();
    req.flush({});
});

it('re-registers and retries once on 400 Unknown X-Device-Id', async () => {
    const {http, ctrl, identity} = setup();

    let result: unknown;
    http.get(CALL_URL).subscribe(r => (result = r));
    await tick();

    ctrl.expectOne(CALL_URL).flush(UNKNOWN_BODY, {status: 400, statusText: 'Bad Request'});
    await tick();

    expect(identity.ensureRegistered).toHaveBeenCalledTimes(1);

    const retry = ctrl.expectOne(CALL_URL);
    expect(retry.request.headers.get('X-Device-Id')).toBe('device-abc');
    retry.flush({ok: true});
    await tick();

    expect(result).toEqual({ok: true});
});

it('does not retry a second time when the retry also fails', async () => {
    const {http, ctrl, identity} = setup();

    let status = 0;
    http.get(CALL_URL).subscribe({error: e => (status = e.status)});
    await tick();

    ctrl.expectOne(CALL_URL).flush(UNKNOWN_BODY, {status: 400, statusText: 'Bad Request'});
    await tick();

    ctrl.expectOne(CALL_URL).flush(UNKNOWN_BODY, {status: 400, statusText: 'Bad Request'});
    await tick();

    expect(identity.ensureRegistered).toHaveBeenCalledTimes(1);
    expect(status).toBe(400);
});

it('does not retry an unrelated 400', async () => {
    const {http, ctrl, identity} = setup();

    let status = 0;
    http.get(CALL_URL).subscribe({error: e => (status = e.status)});
    await tick();

    ctrl.expectOne(CALL_URL).flush('Call already ended', {status: 400, statusText: 'Bad Request'});
    await tick();

    expect(identity.ensureRegistered).not.toHaveBeenCalled();
    expect(status).toBe(400);
});

it('propagates the original error when re-registration fails', async () => {
    const {http, ctrl, identity} = setup();
    identity.ensureRegistered.mockResolvedValue(false);

    let status = 0;
    http.get(CALL_URL).subscribe({error: e => (status = e.status)});
    await tick();

    ctrl.expectOne(CALL_URL).flush(UNKNOWN_BODY, {status: 400, statusText: 'Bad Request'});
    await tick();

    expect(status).toBe(400);
});

it('does not attempt recovery on the device-registration endpoint itself', async () => {
    const {http, ctrl, identity} = setup();
    const url = `${BASE}/api/v1/identity/devices`;

    http.post(url, {}).subscribe({error: () => undefined});
    await tick();

    ctrl.expectOne(url).flush(UNKNOWN_BODY, {status: 400, statusText: 'Bad Request'});
    await tick();

    expect(identity.ensureRegistered).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run ng test --watch=false`
Expected: FAIL - cannot resolve `./device-id-interceptor`.

- [ ] **Step 3: Create the interceptor**

Create `src/app/interceptors/device-id-interceptor.ts`:

```ts
import {HttpErrorResponse, HttpInterceptorFn, HttpRequest} from '@angular/common/http';
import {inject} from '@angular/core';
import {catchError, from, switchMap, throwError} from 'rxjs';
import {ApiConfigService} from '../services/api-config.service';
import {DeviceIdentityService} from '../services/device-identity.service';

/**
 * Stamps `X-Device-Id` on every API request.
 *
 * The backend validates the header on call accept/decline/leave, the Cloudflare session create
 * and guild voice join; elsewhere it is ignored. Sending it everywhere is simpler than
 * maintaining a path list, and costs nothing.
 *
 * Placed *after* `tokenInterceptor` in the chain so the self-hosted base-URL rewrite has already
 * happened by the time the `baseUrl()` guard runs.
 */
export const deviceIdInterceptor: HttpInterceptorFn = (req, next) => {
    const apiConfig = inject(ApiConfigService);
    if (!req.url.startsWith(apiConfig.baseUrl())) return next(req);

    const identity = inject(DeviceIdentityService);

    return from(identity.deviceId()).pipe(
        switchMap(deviceId => {
            const stamped = withDeviceId(req, deviceId);

            return next(stamped).pipe(
                catchError((err: unknown) => {
                    if (!isUnknownDeviceId(err) || isRegistrationRequest(req, apiConfig.baseUrl())) {
                        return throwError(() => err);
                    }

                    // One retry, no recursion: `next(...)` here is not routed back through this
                    // interceptor, so a device id the server keeps rejecting fails on the second
                    // attempt instead of looping.
                    return from(identity.ensureRegistered()).pipe(
                        switchMap(registered => registered
                            ? next(withDeviceId(req, deviceId))
                            : throwError(() => err)),
                    );
                }),
            );
        }),
    );
};

function withDeviceId(req: HttpRequest<unknown>, deviceId: string): HttpRequest<unknown> {
    return req.clone({setHeaders: {'X-Device-Id': deviceId}});
}

/**
 * Matches the body, not just the status: a bare 400 covers everything from a malformed call id
 * to an already-ended call, and retrying those would be wrong.
 */
function isUnknownDeviceId(err: unknown): boolean {
    if (!(err instanceof HttpErrorResponse) || err.status !== 400) return false;
    const body: unknown = err.error;
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
    return text.includes('Unknown X-Device-Id');
}

/** Re-registering in response to a failed registration would be circular. */
function isRegistrationRequest(req: HttpRequest<unknown>, baseUrl: string): boolean {
    return req.url.startsWith(`${baseUrl}/api/v1/identity/devices`);
}
```

- [ ] **Step 4: Register the interceptor**

In `src/app/app.config.ts`, add the import next to the existing interceptor imports (lines 17-19):

```ts
import {deviceIdInterceptor} from "./interceptors/device-id-interceptor";
```

Change line 48 from:

```ts
        provideHttpClient(withInterceptors([tokenInterceptor, timeoutInterceptor])),
```

to:

```ts
        provideHttpClient(withInterceptors([tokenInterceptor, deviceIdInterceptor, timeoutInterceptor])),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run ng test --watch=false`
Expected: PASS. The existing `token-interceptor.spec.ts` suite must still pass - it configures its own interceptor list, so it is unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/app/interceptors/device-id-interceptor.ts src/app/interceptors/device-id-interceptor.spec.ts src/app/app.config.ts
git commit -m "feat: send X-Device-Id on API requests and recover from an unknown id"
```

---

## Task 4: Rust parity - `X-Device-Id` from the media layer

**Files:**
- Modify: `src-tauri/src/media/publisher/signalling.rs:113-140,215-237,255-277,280-320`
- Modify: `src-tauri/src/media/voice/mod.rs:125-148`
- Modify: `src-tauri/src/media/publisher/mod.rs:65-91`
- Modify: `src/app/services/voice-engine.service.ts:77-106`
- Modify: `src/app/services/rust-media.service.ts:21-35,231-245`
- Modify: `src/app/services/screen-publish.ts:49-55`
- Modify: `src/app/services/voice-rtc.service.ts:152-156,626-629`
- Modify: `src/app/services/call-webrtc.service.ts:292-296`
- Modify: `src/app/services/call-session.service.ts:232-236`

**Interfaces:**
- Consumes: `DeviceIdentityService.deviceId()` (Task 1).
- Produces: `Signalling::new(base_url, token, device_id, target, role)`; `VoiceEngineService.start(target, apiBase, token, deviceId)`; `ScreenPublishOptions.deviceId`; `publishOptions(choice, shareId, apiBase, token, deviceId, target)`.

**Why this task cannot be deferred:** today neither the webview nor Rust sends the header, so both land in the implicit `default` bucket and agree. Task 3 just made the webview send a real id. Until this task lands, Rust opens the **primary** Cloudflare session as `default` while the webview joins as the real device - two devices for one user, with the audio-bearing session on the wrong one, which is exactly what device-takeover detection kicks.

- [ ] **Step 1: Write the failing Rust test**

In `src-tauri/src/media/publisher/signalling.rs`, inside the existing `mod tests` block (starts at line 280), update the two constructors and add a test. Replace `with_role` and `call_with_role` so they pass a device id:

```rust
    fn with_role(role: SessionRole) -> Signalling {
        Signalling::new(
            "https://api.example.test/".into(),
            "tok".into(),
            "dev-1".into(),
            VoiceTarget::GuildChannel {
                guild_id: "g1".into(),
                channel_id: "c1".into(),
            },
            role,
        )
        .unwrap()
    }
```

Apply the same `"dev-1".into(),` insertion after the token argument in `call_with_role`.

Add:

```rust
    /// The webview stamps every API request with this header. If Rust does not, the backend sees
    /// two devices for one user - and the one holding the *primary* session is the anonymous
    /// `default` bucket, which reads as a takeover of the user's own call.
    #[test]
    fn carries_the_device_id() {
        assert_eq!(signalling().device_id(), "dev-1");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: FAIL - `Signalling::new` takes 4 arguments, and there is no `device_id` method.

- [ ] **Step 3: Thread the device id through `Signalling`**

In `src-tauri/src/media/publisher/signalling.rs`:

Add the field to the struct (line 114-120):

```rust
pub struct Signalling {
    client: reqwest::Client,
    base_url: String,
    token: String,
    device_id: String,
    target: VoiceTarget,
    role: SessionRole,
}
```

Update the constructor (line 123-140):

```rust
    pub fn new(
        base_url: String,
        token: String,
        device_id: String,
        target: VoiceTarget,
        role: SessionRole,
    ) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            base_url: base_url.trim_end_matches('/').to_owned(),
            token,
            device_id,
            target,
            role,
        })
    }

    /// The device this client acts as, sent as `X-Device-Id` on every request.
    pub fn device_id(&self) -> &str {
        &self.device_id
    }
```

Add the header in `send` (line 261-266):

```rust
        let response = request
            .bearer_auth(&self.token)
            .header("X-Device-Id", &self.device_id)
            .json(body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
```

And in `close_tracks`, which builds its request separately and would otherwise be missed (line 221-231):

```rust
        let response = self
            .client
            .put(&url)
            .bearer_auth(&self.token)
            .header("X-Device-Id", &self.device_id)
            .json(&CloseTracksRequest {
                cf_session_id,
                track_names,
            })
            .send()
            .await
            .map_err(|e| e.to_string())?;
```

- [ ] **Step 4: Accept `device_id` in the two Tauri commands**

In `src-tauri/src/media/voice/mod.rs`, add the parameter to `voice_start` (after `token`, line 129):

```rust
    token: String,
    device_id: String,
```

and pass it through at line 148:

```rust
    let signalling = Signalling::new(api_base, token, device_id, target, SessionRole::Primary)?;
```

In `src-tauri/src/media/publisher/mod.rs`, add the same parameter after `token` (line 72):

```rust
    token: String,
    device_id: String,
```

and at line 91:

```rust
    let signalling = Signalling::new(api_base, token, device_id, target, SessionRole::Secondary)?;
```

- [ ] **Step 5: Run the Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 6: Pass the device id from TypeScript**

In `src/app/services/voice-engine.service.ts`, change `start` (line 77) to:

```ts
    async start(
        target: VoiceTarget,
        apiBase: string,
        token: string,
        deviceId: string,
    ): Promise<VoiceStartResult> {
```

and add to the `invoke` payload (after `token,` at line 97):

```ts
            token,
            deviceId,
```

In `src/app/services/rust-media.service.ts`, add to `ScreenPublishOptions` (after `token: string;` at line 30):

```ts
    token: string;
    /** Same `X-Device-Id` the webview sends; Rust must not appear as a second device. */
    deviceId: string;
```

and to the `invoke` payload (after `token: options.token,` at line 241):

```ts
            token: options.token,
            deviceId: options.deviceId,
```

In `src/app/services/screen-publish.ts`, add the parameter to `publishOptions` (line 49-55):

```ts
export function publishOptions(
    choice: ScreenPickerChoice,
    shareId: string,
    apiBase: string,
    token: string,
    deviceId: string,
    target: {guildId: string; channelId: string} | {callId: string},
): ScreenPublishOptions {
```

and add it to the returned object (line 59-70), next to `apiBase` and `token`:

```ts
    return {
        sourceId: choice.sourceId,
        shareId,
        width,
        height,
        fps: preset.framerate,
        kbps: bitrateFor(preset),
        iceServers: iceServers(),
        apiBase,
        token,
        deviceId,
        ...target,
    };
```

- [ ] **Step 7: Update the four call sites**

Each needs the device id resolved before the call. Inject `DeviceIdentityService` into each service.

`src/app/services/voice-rtc.service.ts` line 152:

```ts
            await this.voiceEngine.start(
                {kind: 'guild', guildId, channelId},
                this.apiConfig.baseUrl(),
                this.oauth.getAccessToken(),
                await this.deviceIdentity.deviceId(),
            );
```

`src/app/services/voice-rtc.service.ts` line 626:

```ts
                publishOptions(
                    choice,
                    shareId,
                    this.apiConfig.baseUrl(),
                    this.oauth.getAccessToken(),
                    await this.deviceIdentity.deviceId(),
                    {guildId, channelId},
                ),
```

`src/app/services/call-webrtc.service.ts` line 292:

```ts
            await this.voiceEngine.start(
                {kind: 'call', callId},
                this.apiConfig.baseUrl(),
                this.oauth.getAccessToken(),
                await this.deviceIdentity.deviceId(),
            );
```

`src/app/services/call-session.service.ts` line 233:

```ts
                publishOptions(
                    choice,
                    shareId,
                    this.apiConfig.baseUrl(),
                    this.oauth.getAccessToken(),
                    await this.deviceIdentity.deviceId(),
                    {callId},
                ),
```

Add to each of those four services' field declarations:

```ts
    private readonly deviceIdentity = inject(DeviceIdentityService);
```

with the import `import {DeviceIdentityService} from './device-identity.service';` (adjust the relative path for `call-session.service.ts` - it is in the same `services/` directory, so the same path works).

- [ ] **Step 8: Run the full suite**

Run: `bun run ng test --watch=false`
Expected: PASS. If any existing spec constructs `publishOptions` or calls `voiceEngine.start`, update its arguments.

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/media src/app/services/voice-engine.service.ts src/app/services/rust-media.service.ts src/app/services/screen-publish.ts src/app/services/voice-rtc.service.ts src/app/services/call-webrtc.service.ts src/app/services/call-session.service.ts
git commit -m "fix: send X-Device-Id from the Rust media layer too

The webview now stamps a real device id. Without this the primary
Cloudflare session opens as the anonymous default bucket while the
webview joins as a real device - one user, two devices, and the
takeover detection kicks the user off their own call."
```

---

## Task 5: Hub connects with `?deviceId=`

**Files:**
- Modify: `src/app/services/realtime-connection.service.ts`
- Create: `src/app/services/realtime-connection.service.spec.ts`

**Interfaces:**
- Consumes: `DeviceIdentityService.deviceId()` (Task 1).
- Produces: no API change. `on`, `off`, `invoke`, `start`, `connectionState` keep their current signatures, so `MessagingWebsocketService`, `VoiceWebsocketService`, `GuildWebsocketService` and `IsleVoiceWebsocketService` need no edits.

- [ ] **Step 1: Write the failing test**

Create `src/app/services/realtime-connection.service.spec.ts`:

```ts
/**
 * The connection is now built lazily, because the URL needs an async-resolved device id. Every
 * consuming service relies on `.on()` being safe to call before `.start()`, so the queue-then-
 * replay behaviour is the contract under test.
 */
// `vi.hoisted` is required, not stylistic: `vi.mock` factories are hoisted above every
// declaration in the file, so a plain `const builtUrls = []` referenced inside one is still in
// its temporal dead zone when the factory runs.
const {builtUrls, connection} = vi.hoisted(() => ({
    builtUrls: [] as string[],
    connection: {
        state: 'Disconnected',
        on: vi.fn(),
        off: vi.fn(),
        invoke: vi.fn(),
        start: vi.fn(async () => undefined),
        onreconnecting: vi.fn(),
        onreconnected: vi.fn(),
        onclose: vi.fn(),
    },
}));

vi.mock('@microsoft/signalr', () => {
    const builder = {
        withUrl: vi.fn((url: string) => {
            builtUrls.push(url);
            return builder;
        }),
        withAutomaticReconnect: vi.fn(() => builder),
        build: vi.fn(() => connection),
    };
    return {
        HubConnectionBuilder: vi.fn(() => builder),
        HubConnectionState: {Connected: 'Connected', Disconnected: 'Disconnected'},
    };
});

import {TestBed} from '@angular/core/testing';
import {RealtimeConnectionService} from './realtime-connection.service';
import {DeviceIdentityService} from './device-identity.service';
import {ApiConfigService} from './api-config.service';
import {AuthService} from './auth.service';
import {NotificationService} from './notification.service';

const conn = connection;

function setup(deviceId: () => Promise<string> = async () => 'device-abc') {
    builtUrls.length = 0;
    vi.clearAllMocks();

    TestBed.configureTestingModule({
        providers: [
            {provide: DeviceIdentityService, useValue: {deviceId}},
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.venta.gg'}},
            {provide: AuthService, useValue: {ensureValidToken: async () => 'tok'}},
            {provide: NotificationService, useValue: {createNotification: async () => undefined}},
        ],
    });

    return TestBed.inject(RealtimeConnectionService);
}

it('connects with the device id as a query parameter', async () => {
    const service = setup();

    await service.start();

    expect(builtUrls[0]).toBe('https://api.venta.gg/api/v1/ws/hub?deviceId=device-abc');
});

it('replays handlers registered before start', async () => {
    const service = setup();
    const handler = vi.fn();

    service.on('call.CallEnded', handler);
    expect(conn.on).not.toHaveBeenCalled();

    await service.start();

    expect(conn.on).toHaveBeenCalledWith('call.CallEnded', handler);
});

it('connects without the parameter when the device id cannot be resolved', async () => {
    const service = setup(async () => {
        throw new Error('store locked');
    });

    await service.start();

    expect(builtUrls[0]).toBe('https://api.venta.gg/api/v1/ws/hub');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run ng test --watch=false`
Expected: FAIL - the URL has no `?deviceId=`, and `on()` reaches the connection immediately because it is built in the constructor.

- [ ] **Step 3: Rewrite the service**

Replace `src/app/services/realtime-connection.service.ts` in full:

```ts
import {inject, Injectable, signal} from '@angular/core';
import * as signalR from '@microsoft/signalr';
import {AuthService} from './auth.service';
import {NotificationService, NotificationSound} from './notification.service';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';

export enum ConnectionState {
    Connected,
    Disconnected,
    Connecting,
}

/**
 * Owns the single SignalR connection for the whole app (`/api/v1/ws/hub`).
 *
 * Since the backend cutover to one connection per user, every feature that used
 * to have its own hub (messaging, voice/calls, guild) now shares this connection.
 * Event and method names are domain-prefixed (`conversation.*`, `presence.*`,
 * `call.*`, `guild.*`, `guild.voice.*`) so a single pipe can carry all of them.
 *
 * The connection is built on first {@link start} rather than in the constructor: the URL carries
 * a `deviceId` the server buckets per-device events by, and resolving it is async. Handlers
 * registered before then are queued and replayed, because every consuming service relies on
 * {@link on} being safe to call before {@link start}.
 */
@Injectable({providedIn: 'root'})
export class RealtimeConnectionService {
    public readonly connectionState = signal(ConnectionState.Disconnected);
    private hubConnection: signalR.HubConnection | null = null;
    private pendingHandlers: { event: string; handler: (...args: any[]) => void }[] = [];
    private readonly authService = inject(AuthService);
    private readonly notificationService = inject(NotificationService);
    private readonly apiConfig = inject(ApiConfigService);
    private readonly deviceIdentity = inject(DeviceIdentityService);
    private starting?: Promise<void>;
    private reconnectNotified = false;

    /** Register a server → client event handler. Safe to call before or after {@link start}. */
    on(event: string, handler: (...args: any[]) => void): void {
        if (this.hubConnection) {
            this.hubConnection.on(event, handler);
            return;
        }
        this.pendingHandlers.push({event, handler});
    }

    /** Remove all handlers for an event. */
    off(event: string): void {
        this.pendingHandlers = this.pendingHandlers.filter(h => h.event !== event);
        this.hubConnection?.off(event);
    }

    /**
     * Fire a client → server invocation. No-op when disconnected and never rejects
     * -errors are logged so callers can treat it as fire-and-forget.
     */
    async invoke(method: string, ...args: unknown[]): Promise<void> {
        if (!this.hubConnection) return;
        if (this.hubConnection.state !== signalR.HubConnectionState.Connected) return;
        try {
            await this.hubConnection.invoke(method, ...args);
        } catch (err) {
            console.error(`Realtime invoke '${method}' failed:`, err);
        }
    }

    /** Idempotent: starts the connection once; concurrent callers share one attempt. */
    async start(): Promise<void> {
        if (this.hubConnection?.state === signalR.HubConnectionState.Connected) return;
        if (this.starting) return this.starting;

        this.starting = this.build()
            .then(connection => connection.start())
            .then(() => {
                this.connectionState.set(ConnectionState.Connected);
            })
            .catch(err => {
                console.error('Realtime: connection error', err);
                this.connectionState.set(ConnectionState.Disconnected);
            })
            .finally(() => {
                this.starting = undefined;
            });

        return this.starting;
    }

    private async build(): Promise<signalR.HubConnection> {
        if (this.hubConnection) return this.hubConnection;

        const connection = new signalR.HubConnectionBuilder()
            .withUrl(await this.hubUrl(), {
                accessTokenFactory: () => this.authService.ensureValidToken(),
            })
            .withAutomaticReconnect({
                nextRetryDelayInMilliseconds: retryContext =>
                    Math.min(1000 * Math.pow(2, retryContext.previousRetryCount), 60_000),
            })
            .build();

        this.hubConnection = connection;
        this.wireLifecycle(connection);

        for (const {event, handler} of this.pendingHandlers) connection.on(event, handler);
        this.pendingHandlers = [];

        return connection;
    }

    /**
     * A device id we cannot resolve degrades to no parameter rather than failing the connection.
     * The hub applies no validation - it just falls back to the `default` bucket - so a broken
     * store costs per-device event routing, not the whole realtime layer.
     */
    private async hubUrl(): Promise<string> {
        const base = `${this.apiConfig.baseUrl()}/api/v1/ws/hub`;
        try {
            return `${base}?deviceId=${encodeURIComponent(await this.deviceIdentity.deviceId())}`;
        } catch (err) {
            console.error('Realtime: could not resolve device id, connecting without it', err);
            return base;
        }
    }

    private wireLifecycle(connection: signalR.HubConnection): void {
        connection.onreconnecting(() => {
            if (!this.reconnectNotified) {
                this.reconnectNotified = true;
                this.notificationService.createNotification({
                    title: 'Reconnecting',
                    message: 'Attempting to reconnect...',
                    sound: NotificationSound.NewMessage,
                }).catch(() => {
                });
            }
            this.connectionState.set(ConnectionState.Connecting);
        });

        connection.onreconnected(() => {
            this.reconnectNotified = false;
            this.connectionState.set(ConnectionState.Connected);
        });

        connection.onclose(() => {
            this.reconnectNotified = false;
            this.connectionState.set(ConnectionState.Disconnected);
        });
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run ng test --watch=false`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/realtime-connection.service.ts src/app/services/realtime-connection.service.spec.ts
git commit -m "feat: connect the realtime hub with a deviceId query param"
```

---

## Task 6: Push tokens carry their device, and are removed on sign-out

**Files:**
- Modify: `src/app/services/user-token.service.ts`
- Create: `src/app/services/user-token.service.spec.ts`
- Modify: `src/app/features/settings/logout-dialog/logout-dialog.component.ts:114-135`

**Interfaces:**
- Consumes: `DeviceIdentityService.deviceId()` (Task 1).
- Produces: `UserTokenService.ensureTokenRegistered(): Promise<void>` (unchanged signature, new behaviour); `UserTokenService.deregisterToken(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `src/app/services/user-token.service.spec.ts`:

```ts
/**
 * Push tokens now carry the device they belong to, which is what lets the server leave out the
 * device already dealing with an event. Deregistration is what stops a signed-out handset ringing.
 */
vi.mock('@tauri-apps/plugin-store');
vi.mock('@tauri-apps/plugin-os', () => ({type: vi.fn(() => 'windows')}));
vi.mock('@choochmeque/tauri-plugin-notifications-api', () => ({
    isPermissionGranted: vi.fn(async () => true),
    requestPermission: vi.fn(async () => 'granted'),
    registerForPushNotifications: vi.fn(async () => 'push-token-xyz'),
}));

import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {LazyStore} from '@tauri-apps/plugin-store';
import {type as osType} from '@tauri-apps/plugin-os';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';
import {UserTokenService} from './user-token.service';

const BASE = 'https://api.venta.gg';
const PUSH_URL = `${BASE}/api/v1/identity/users/self/push-token`;

const store = {get: vi.fn(), set: vi.fn(), delete: vi.fn(), save: vi.fn()};

beforeEach(() => {
    vi.clearAllMocks();
    store.get.mockResolvedValue(null);
    store.set.mockResolvedValue(undefined);
    store.delete.mockResolvedValue(undefined);
    store.save.mockResolvedValue(undefined);
    vi.mocked(LazyStore).mockImplementation(() => store as unknown as LazyStore);
    vi.mocked(osType).mockReturnValue('windows');
});

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device-abc'}},
        ],
    });
    return {
        service: TestBed.inject(UserTokenService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

function tick() {
    return new Promise<void>(r => setTimeout(r, 0));
}

it('registers the token with its kind and device', async () => {
    const {service, ctrl} = setup();

    void service.ensureTokenRegistered();
    await tick();

    const req = ctrl.expectOne(PUSH_URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
        token: 'push-token-xyz',
        kind: 'Fcm',
        deviceId: 'device-abc',
    });
    req.flush({}, {status: 201, statusText: 'Created'});
});

it('registers an iOS token as the PushKit transport CallKit needs', async () => {
    vi.mocked(osType).mockReturnValue('ios');
    const {service, ctrl} = setup();

    void service.ensureTokenRegistered();
    await tick();

    const req = ctrl.expectOne(PUSH_URL);
    expect(req.request.body.kind).toBe('ApnsVoip');
    req.flush({});
});

it('persists the token so sign-out can delete it', async () => {
    const {service, ctrl} = setup();

    void service.ensureTokenRegistered();
    await tick();
    ctrl.expectOne(PUSH_URL).flush({});
    await tick();

    expect(store.set).toHaveBeenCalledWith('push_token', {token: 'push-token-xyz', kind: 'Fcm'});
});

it('deregisters the persisted token', async () => {
    store.get.mockResolvedValue({token: 'push-token-xyz', kind: 'Fcm'});
    const {service, ctrl} = setup();

    void service.deregisterToken();
    await tick();

    const req = ctrl.expectOne(r => r.url === PUSH_URL && r.method === 'DELETE');
    expect(req.request.params.get('token')).toBe('push-token-xyz');
    expect(req.request.params.get('kind')).toBe('Fcm');
    req.flush(null, {status: 204, statusText: 'No Content'});
});

it('does nothing on deregister when no token was ever registered', async () => {
    const {service, ctrl} = setup();

    await service.deregisterToken();

    ctrl.expectNone(() => true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run ng test --watch=false`
Expected: FAIL - the service posts to `device-token` with a bare `{token}`, and `deregisterToken` does not exist.

- [ ] **Step 3: Rewrite the service**

Replace `src/app/services/user-token.service.ts` in full:

```ts
import {inject, Injectable} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {HttpClient, HttpParams} from '@angular/common/http';
import {
    isPermissionGranted,
    registerForPushNotifications,
    requestPermission,
} from '@choochmeque/tauri-plugin-notifications-api';
import {type as osType} from '@tauri-apps/plugin-os';
import {LazyStore} from '@tauri-apps/plugin-store';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';

const STORE_FILE = 'settings.json';
const PUSH_TOKEN_KEY = 'push_token';

/** Transports the backend accepts. `Fcm` covers Android notifications and the Android call ring. */
type PushKind = 'Fcm' | 'ApnsVoip';

interface StoredPushToken {
    token: string;
    kind: PushKind;
}

@Injectable({
    providedIn: 'root',
})
export class UserTokenService {
    private client = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);
    private deviceIdentity = inject(DeviceIdentityService);

    public async ensureTokenRegistered(): Promise<void> {
        let permissionGranted = await isPermissionGranted();
        if (!permissionGranted) {
            const permission = await requestPermission();
            permissionGranted = permission === 'granted';
        }
        try {
            const token = await registerForPushNotifications();
            const kind = this.pushKind();

            // The device id is what lets the server leave out the device already handling an
            // event - without it the token can be neither targeted nor cleaned up.
            await firstValueFrom(this.client.post(this.pushTokenUrl(), {
                token,
                kind,
                deviceId: await this.deviceIdentity.deviceId(),
            }));

            await this.rememberToken({token, kind});
        } catch (error) {
            console.error('Failed to register for push notifications:', error);
        }
    }

    /**
     * Stops this installation being rung after sign-out. The token value has to come from our own
     * store: by the time logout runs, asking the push plugin for it again is not dependable.
     */
    public async deregisterToken(): Promise<void> {
        try {
            const stored = await this.storedToken();
            if (!stored) return;

            const params = new HttpParams()
                .set('token', stored.token)
                .set('kind', stored.kind);

            await firstValueFrom(this.client.delete(this.pushTokenUrl(), {params}));
            await this.forgetToken();
        } catch (error) {
            console.error('Failed to deregister push token:', error);
        }
    }

    private pushTokenUrl(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/identity/users/self/push-token`;
    }

    /** iOS needs the PushKit token CallKit rings from; everything else uses Firebase. */
    private pushKind(): PushKind {
        return osType() === 'ios' ? 'ApnsVoip' : 'Fcm';
    }

    private async storedToken(): Promise<StoredPushToken | null> {
        const store = new LazyStore(STORE_FILE);
        return (await store.get<StoredPushToken>(PUSH_TOKEN_KEY)) ?? null;
    }

    private async rememberToken(value: StoredPushToken): Promise<void> {
        const store = new LazyStore(STORE_FILE);
        await store.set(PUSH_TOKEN_KEY, value);
        await store.save();
    }

    private async forgetToken(): Promise<void> {
        const store = new LazyStore(STORE_FILE);
        await store.delete(PUSH_TOKEN_KEY);
        await store.save();
    }
}
```

The unused `environment` and `WikiDto` imports from the old file are dropped deliberately - neither was referenced.

- [ ] **Step 4: Deregister on sign-out**

In `src/app/features/settings/logout-dialog/logout-dialog.component.ts`, add the import and injection:

```ts
import {UserTokenService} from '../../../services/user-token.service';
```

```ts
    private userTokenService = inject(UserTokenService);
```

Replace `doLogout` (line 131-135) with:

```ts
    private doLogout(): void {
        this.visibleChange.emit(false);
        // Fire-and-forget: a failed push cleanup must not strand the user in a session they
        // asked to leave. `deregisterToken` already swallows its own errors.
        void this.userTokenService.deregisterToken();
        this.authService.logout();
        this.router.navigate(['/authentication']);
    }
```

The device row itself is deliberately **not** deleted here: `DELETE /identity/devices/client/{id}` cascades away the MLS key packages and the encrypted backup, and logout already wipes the local signing key, so the row is inert either way. Forgetting a device is an explicit action in settings (Task 8).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run ng test --watch=false`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/user-token.service.ts src/app/services/user-token.service.spec.ts src/app/features/settings/logout-dialog/logout-dialog.component.ts
git commit -m "feat: register push tokens against their device and drop them on sign-out"
```

---

## Task 7: `device_id` at token exchange and QR login

**Files:**
- Modify: `src/app/services/auth.service.ts:26-41`
- Modify: `src/app/services/qr-login.service.ts:36-39,94-102`
- Modify: `src/app/dtos/request/qr-login.dto.ts`
- Modify: `src/app/services/qr-login.service.spec.ts`
- Create: `src/app/services/auth.service.spec.ts`

**Interfaces:**
- Consumes: `DeviceIdentityService.deviceId()` (Task 1).
- Produces: `StartQrLoginDto.clientDeviceId?: string`. `AuthService.login` and `QrLoginService.start` keep their signatures.

- [ ] **Step 1: Write the failing tests**

Create `src/app/services/auth.service.spec.ts`:

```ts
/**
 * The session minted at /connect/token is what `DELETE /sessions/{id}` later uses to find and
 * kill this device's push. That link only exists if the token request carries the device id.
 */
import {TestBed} from '@angular/core/testing';
import {firstValueFrom} from 'rxjs';
import {OAuthService} from 'angular-oauth2-oidc';
import {AuthService} from './auth.service';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';

function setup() {
    const oauth = {
        fetchTokenUsingGrant: vi.fn(async () => ({access_token: 'tok'})),
        configure: vi.fn(),
    };

    TestBed.configureTestingModule({
        providers: [
            {provide: OAuthService, useValue: oauth},
            {provide: ApiConfigService, useValue: {applyLoginInput: (i: string) => i}},
            {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device-abc'}},
        ],
    });

    return {service: TestBed.inject(AuthService), oauth};
}

it('sends the device id and a device label at token exchange', async () => {
    const {service, oauth} = setup();

    await firstValueFrom(service.login('alice', 'hunter2'));

    const [grant, params] = oauth.fetchTokenUsingGrant.mock.calls[0];
    expect(grant).toBe('password');
    expect(params.username).toBe('alice');
    expect(params.device_id).toBe('device-abc');
    expect(params.device_name).toBeTruthy();
    expect(params.device_type).toBeTruthy();
});

it('still logs in when the device id cannot be resolved', async () => {
    TestBed.resetTestingModule();
    const oauth = {fetchTokenUsingGrant: vi.fn(async () => ({access_token: 'tok'})), configure: vi.fn()};
    TestBed.configureTestingModule({
        providers: [
            {provide: OAuthService, useValue: oauth},
            {provide: ApiConfigService, useValue: {applyLoginInput: (i: string) => i}},
            {
                provide: DeviceIdentityService,
                useValue: {
                    deviceId: async () => {
                        throw new Error('store locked');
                    },
                },
            },
        ],
    });

    await firstValueFrom(TestBed.inject(AuthService).login('alice', 'hunter2'));

    const [, params] = oauth.fetchTokenUsingGrant.mock.calls[0];
    expect(params.device_id).toBeUndefined();
    expect(params.username).toBe('alice');
});

it('passes the mfa code through unchanged', async () => {
    const {service, oauth} = setup();

    await firstValueFrom(service.login('alice', 'hunter2', '123456'));

    expect(oauth.fetchTokenUsingGrant.mock.calls[0][1].mfa_code).toBe('123456');
});
```

Add to `src/app/services/qr-login.service.spec.ts` - extend the existing `setup()` providers with:

```ts
            {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device-abc'}},
```

(import it from `./device-identity.service`) and append:

```ts
it('carries the client device id into the pairing', async () => {
    const {service, ctrl} = setup();

    service.start().subscribe();
    await new Promise<void>(r => setTimeout(r, 0));

    const req = ctrl.expectOne(`${BASE}/api/v1/identity/qr-login/start`);
    expect(req.request.body.clientDeviceId).toBe('device-abc');
    expect(req.request.body.deviceName).toBeTruthy();
    req.flush({code: 'ABC123', expiresInSeconds: 180});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run ng test --watch=false`
Expected: FAIL - `params.device_id` is undefined and the QR body has no `clientDeviceId`.

- [ ] **Step 3: Add the device id to `AuthService.login`**

In `src/app/services/auth.service.ts`, add the imports:

```ts
import {DeviceIdentityService} from './device-identity.service';
import {describeCurrentDevice} from './qr-login.service';
```

and `from`, `switchMap` to the rxjs import if not already present. Add the field:

```ts
    private deviceIdentity = inject(DeviceIdentityService);
```

Replace `login` (line 27-41) with:

```ts
    /** Accepts `username` or `user@server.com`, resolves the server, then logs in. */
    public login(input: string, password: string, mfaCode?: string): Observable<TokenResponse> {
        const username = this.apiConfig.applyLoginInput(input);
        // fetchTokenUsingPasswordFlow is exactly fetchTokenUsingGrant('password', {username, password});
        // going through the grant call directly is the only way to add the mfa_code field the
        // backend reads off the token request.
        const parameters: Record<string, string> = {username, password};
        if (mfaCode) parameters['mfa_code'] = mfaCode;

        const {deviceName, deviceType} = describeCurrentDevice();
        parameters['device_name'] = deviceName;
        parameters['device_type'] = deviceType;

        // A first login on a fresh install necessarily happens before the device can be
        // registered, and the server ignores an unknown id - so an unresolvable id is not a
        // reason to block signing in. It links from the next login onward.
        return from(this.deviceIdentity.deviceId().catch(() => null)).pipe(
            switchMap(deviceId => {
                if (deviceId) parameters['device_id'] = deviceId;
                return from(this.oauthService.fetchTokenUsingGrant('password', parameters));
            }),
            tap({
                error: (err) => console.error('Login failed', err)
            }),
            catchError((err) => throwError(() => err))
        );
    }
```

- [ ] **Step 4: Add the device id to QR login**

In `src/app/dtos/request/qr-login.dto.ts`:

```ts
import {DeviceType} from '../response/user-device.dto';

export interface StartQrLoginDto {
    /** Human-readable label shown to the approving phone and later in the sessions list. */
    deviceName: string;
    deviceType: DeviceType;
    /** Carried through the pairing and attached to the session minted at /connect/token. */
    clientDeviceId?: string;
}
```

In `src/app/services/qr-login.service.ts`, add the import and injection:

```ts
import {DeviceIdentityService} from './device-identity.service';
```

```ts
    private deviceIdentity = inject(DeviceIdentityService);
```

Replace `start` (line 36-39) with:

```ts
    /** Mints a pairing code valid for `expiresInSeconds`. Call again rather than reusing an expired one. */
    start(device: StartQrLoginDto = describeCurrentDevice()): Observable<QrLoginStartResponse> {
        return from(this.deviceIdentity.deviceId().catch(() => null)).pipe(
            switchMap(clientDeviceId => this.http.post<QrLoginStartResponse>(
                `${this.base}/start`,
                clientDeviceId ? {...device, clientDeviceId} : device,
            )),
        );
    }
```

Add `switchMap` to the rxjs import (`from` is already imported).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run ng test --watch=false`
Expected: PASS, including the existing `qr-login.service.spec.ts` cases.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/auth.service.ts src/app/services/auth.service.spec.ts src/app/services/qr-login.service.ts src/app/services/qr-login.service.spec.ts src/app/dtos/request/qr-login.dto.ts
git commit -m "feat: link login sessions to the device that created them"
```

---

## Task 8: Sessions UI - show the device and let it be forgotten

**Files:**
- Modify: `src/app/dtos/response/login-session.dto.ts`
- Modify: `src/app/features/settings/settings-modal/pages/devices-settings/devices-settings.component.ts`
- Modify: `src/app/features/settings/settings-modal/pages/devices-settings/devices-settings.component.html`
- Modify: `src/assets/i18n/locales/{en,de,fr}.json` (submodule)

**Interfaces:**
- Consumes: `DeviceService.deleteDevice()` (Task 2), `DeviceIdentityService.deviceId()` (Task 1).
- Produces: nothing consumed by later tasks.

**Scope note:** the sessions list is deliberately **not** merged with `GET /identity/devices`. `UserDeviceDto` carries no `clientDeviceId`, so the join key does not exist on that side. See the design doc §7.

- [ ] **Step 1: Add the DTO field**

In `src/app/dtos/response/login-session.dto.ts`, add to the interface:

```ts
    /** True for the session whose access token made this request. */
    isCurrent: boolean;
    /** The registered device this login came from; null for logins that sent none. */
    clientDeviceId: string | null;
```

- [ ] **Step 2: Add the forget action to the component**

In `src/app/features/settings/settings-modal/pages/devices-settings/devices-settings.component.ts`, add the imports:

```ts
import {DeviceService} from '../../../../../services/device.service';
import {DeviceIdentityService} from '../../../../../services/device-identity.service';
```

Add the fields, next to the existing `revoking` / `pendingRevoke` signals:

```ts
    /** Client device id of this installation, used to mark our own row. */
    protected ownDeviceId = signal<string | null>(null);
    /** Client device id a forget request is currently in flight for. */
    protected forgetting = signal<string | null>(null);
    protected pendingForget = signal<LoginSessionDto | null>(null);
```

and the injections:

```ts
    private deviceService = inject(DeviceService);
    private deviceIdentity = inject(DeviceIdentityService);
```

In the constructor, after `this.load();`:

```ts
        // Marks the row belonging to this installation. `isCurrent` only identifies the token
        // that made the request; this identifies the machine, which is what the user recognises.
        void this.deviceIdentity.deviceId()
            .then(id => this.ownDeviceId.set(id))
            .catch(() => this.ownDeviceId.set(null));
```

Add the methods after `revoke()`:

```ts
    protected isThisDevice(session: LoginSessionDto): boolean {
        const own = this.ownDeviceId();
        return session.isCurrent || (!!own && session.clientDeviceId === own);
    }

    protected confirmForget(session: LoginSessionDto): void {
        this.pendingForget.set(session);
    }

    protected forget(): void {
        const session = this.pendingForget();
        if (!session?.clientDeviceId || this.forgetting()) return;

        const clientDeviceId = session.clientDeviceId;
        this.forgetting.set(clientDeviceId);
        this.deviceService.deleteDevice(clientDeviceId).subscribe({
            next: () => {
                // Every session from that device is revoked server-side, so drop them all rather
                // than only the row that was clicked.
                this.sessions.update(list => list.filter(s => s.clientDeviceId !== clientDeviceId));
                this.forgetting.set(null);
                this.pendingForget.set(null);
                this.toast.success(
                    this.translate.instant('SETTINGS.DEVICES.FORGOTTEN', {device: session.deviceName}),
                );
            },
            error: err => {
                this.forgetting.set(null);
                this.pendingForget.set(null);
                this.toast.httpError(this.translate.instant('SETTINGS.DEVICES.FORGET_FAILED'), err);
            },
        });
    }
```

- [ ] **Step 3: Add the forget affordance to the template**

In `devices-settings.component.html`, change the "this device" badge condition on line 47 from `@if (session.isCurrent) {` to:

```html
                                @if (isThisDevice(session)) {
```

Add a forget button immediately before the closing `</li>` on line 87 (after the existing revoke `@if`/`@else` block):

```html
                        @if (session.clientDeviceId) {
                            <p-button (onClick)="confirmForget(session)"
                                      [ariaLabel]="'SETTINGS.DEVICES.FORGET' | translate"
                                      [loading]="forgetting() === session.clientDeviceId"
                                      [pTooltip]="'SETTINGS.DEVICES.FORGET' | translate"
                                      [text]="true"
                                      icon="pi pi-trash"
                                      severity="danger"
                                      size="small"
                                      styleClass="shrink-0"
                                      tooltipPosition="left"/>
                        }
```

Append a confirm dialog after the existing revoke dialog (end of file):

```html
<!-- Forget confirm -->
<p-dialog [header]="'SETTINGS.DEVICES.FORGET_TITLE' | translate"
          [closable]="!forgetting()"
          [dismissableMask]="!forgetting()"
          [draggable]="false"
          [modal]="true"
          [resizable]="false"
          [style]="{width: '400px'}"
          [visible]="!!pendingForget()"
          (visibleChange)="$event || pendingForget.set(null)"
          appendTo="body">
    @if (pendingForget(); as session) {
        <div class="flex flex-col gap-4 pt-1">
            <p class="text-[0.8125rem] text-text-secondary">
                {{ 'SETTINGS.DEVICES.FORGET_DESC' | translate: {device: session.deviceName} }}
            </p>

            <div class="flex items-start gap-3 bg-card border border-border rounded-lg px-4 py-3">
                <i class="pi pi-exclamation-triangle text-offline shrink-0 mt-0.5"></i>
                <p class="text-[0.8125rem] text-text-secondary">
                    {{ 'SETTINGS.DEVICES.FORGET_WARNING' | translate }}
                </p>
            </div>

            <div class="flex gap-3 justify-end">
                <p-button (onClick)="pendingForget.set(null)"
                          [disabled]="!!forgetting()"
                          [label]="'SETTINGS.DEVICES.CANCEL' | translate"
                          severity="secondary"
                          size="small"/>
                <p-button (onClick)="forget()"
                          [label]="'SETTINGS.DEVICES.FORGET_CONFIRM' | translate"
                          [loading]="!!forgetting()"
                          severity="danger"
                          size="small"/>
            </div>
        </div>
    }
</p-dialog>
```

- [ ] **Step 4: Add the locale strings**

The locales directory is a git submodule and needs its own commit. Add these keys after the existing `SETTINGS.DEVICES.*` block in `src/assets/i18n/locales/en.json`:

```json
  "SETTINGS.DEVICES.FORGET": "Forget this device",
  "SETTINGS.DEVICES.FORGET_TITLE": "Forget Device",
  "SETTINGS.DEVICES.FORGET_DESC": "{{device}} will be removed from your account and signed out.",
  "SETTINGS.DEVICES.FORGET_WARNING": "Its encryption keys and encrypted backup are deleted for good. Messages it holds cannot be recovered on that device.",
  "SETTINGS.DEVICES.FORGET_CONFIRM": "Forget Device",
  "SETTINGS.DEVICES.FORGOTTEN": "{{device}} forgotten",
  "SETTINGS.DEVICES.FORGET_FAILED": "Could not forget that device",
```

Add the same keys to `de.json` and `fr.json`. German:

```json
  "SETTINGS.DEVICES.FORGET": "Dieses Gerät entfernen",
  "SETTINGS.DEVICES.FORGET_TITLE": "Gerät entfernen",
  "SETTINGS.DEVICES.FORGET_DESC": "{{device}} wird von deinem Konto entfernt und abgemeldet.",
  "SETTINGS.DEVICES.FORGET_WARNING": "Die Schlüssel und das verschlüsselte Backup werden endgültig gelöscht. Nachrichten auf diesem Gerät lassen sich nicht wiederherstellen.",
  "SETTINGS.DEVICES.FORGET_CONFIRM": "Gerät entfernen",
  "SETTINGS.DEVICES.FORGOTTEN": "{{device}} entfernt",
  "SETTINGS.DEVICES.FORGET_FAILED": "Gerät konnte nicht entfernt werden",
```

French:

```json
  "SETTINGS.DEVICES.FORGET": "Oublier cet appareil",
  "SETTINGS.DEVICES.FORGET_TITLE": "Oublier l'appareil",
  "SETTINGS.DEVICES.FORGET_DESC": "{{device}} sera retiré de votre compte et déconnecté.",
  "SETTINGS.DEVICES.FORGET_WARNING": "Ses clés de chiffrement et sa sauvegarde chiffrée seront définitivement supprimées. Les messages qu'il contient ne pourront pas être récupérés sur cet appareil.",
  "SETTINGS.DEVICES.FORGET_CONFIRM": "Oublier l'appareil",
  "SETTINGS.DEVICES.FORGOTTEN": "{{device}} oublié",
  "SETTINGS.DEVICES.FORGET_FAILED": "Impossible d'oublier cet appareil",
```

- [ ] **Step 5: Verify the build**

Run: `bun run ng build --configuration development`
Expected: success. Template type-checking catches a mistyped signal or method name here, which `ng test` would not.

Run: `bun run ng test --watch=false`
Expected: PASS.

- [ ] **Step 6: Commit - submodule first, then the parent**

```bash
git -C src/assets/i18n/locales add en.json de.json fr.json
git -C src/assets/i18n/locales commit -m "feat: add strings for forgetting a device"
git -C src/assets/i18n/locales push
git add src/assets/i18n/locales src/app/dtos/response/login-session.dto.ts src/app/features/settings/settings-modal/pages/devices-settings
git commit -m "feat: identify and forget devices from the sessions list"
```

---

## Task 9: Call hang-up means leave, not end

**Files:**
- Modify: `src/app/services/voice.service.ts:64-80`
- Modify: `src/app/services/call-session.service.ts:80-89`
- Modify: `src/app/services/call-state.service.ts:115-124`
- Create: `src/app/services/call-session.service.spec.ts`

**Interfaces:**
- Produces: `VoiceService.leaveCall(callId: string): Observable<CallDto>`; `CallSessionService.end(silent = false): void`; `CallSessionService.aloneDeadline` (a `Signal<Date | null>`) and `setAloneDeadline(deadline: Date | null): void`. Tasks 11 and 12 consume all of these.

**Backend note:** `PUT /call/{id}/leave` does not exist on the currently deployed backend and will 404 until the deploy. That is the one regression in this plan, inherited from the 2026-07-29 decision to implement the contract ahead of the server.

- [ ] **Step 1: Write the failing test**

Create `src/app/services/call-session.service.spec.ts`:

```ts
/**
 * Hanging up must remove only the local user. Ending the call for everyone is what made a
 * decline on one device kill an active call on another.
 */
import {TestBed} from '@angular/core/testing';
import {of} from 'rxjs';
import {CallSessionService} from './call-session.service';
import {VoiceService} from './voice.service';
import {ConversationStore} from '../stores/conversation.store';
import {ProfileService} from './profile.service';

const voiceService = {
    leaveCall: vi.fn(() => of({})),
    endCall: vi.fn(() => of({})),
};

function setup() {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
        providers: [
            {provide: VoiceService, useValue: voiceService},
            {provide: ConversationStore, useValue: {entities: () => []}},
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'me'}), getCachedByUserId: () => null}},
        ],
    });

    const service = TestBed.inject(CallSessionService);
    service.session.set({
        callId: 'call-1',
        conversationId: 'conv-1',
        participants: [],
        screenShares: [],
        local: {isMuted: false, isDeafened: false, isCameraOn: false, isSharing: false},
        startedAt: new Date(),
    } as never);
    return service;
}

it('leaves the call rather than ending it for everyone', () => {
    const service = setup();

    service.end();

    expect(voiceService.leaveCall).toHaveBeenCalledWith('call-1');
    expect(voiceService.endCall).not.toHaveBeenCalled();
    expect(service.session()).toBeNull();
});

it('skips the network call when the server already tore the call down', () => {
    const service = setup();

    service.end(true);

    expect(voiceService.leaveCall).not.toHaveBeenCalled();
    expect(service.session()).toBeNull();
});

it('clears the alone deadline on end', () => {
    const service = setup();
    service.setAloneDeadline(new Date());

    service.end(true);

    expect(service.aloneDeadline()).toBeNull();
});

it('clears the alone deadline once someone rejoins', () => {
    const service = setup();
    service.onParticipantJoined('them');
    service.setAloneDeadline(new Date());

    service.onParticipantJoined('someone-else');

    expect(service.aloneDeadline()).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run ng test --watch=false`
Expected: FAIL - `end()` calls `endCall`, and `setAloneDeadline` does not exist.

- [ ] **Step 3: Add `leaveCall` to `VoiceService`**

In `src/app/services/voice.service.ts`, add after `declineCall` (line 70):

```ts
    /**
     * Removes only the local user. Dropping to zero connected participants ends the call
     * server-side; dropping to one starts a grace period before it is force-ended.
     *
     * This is what the single hang-up button now does. {@link endCall} ends it for everyone and
     * is left in place unused - the app has no host concept and no "end for everyone" action.
     */
    leaveCall(callId: string): Observable<CallDto> {
        return this.client.put<CallDto>(`${this.base}/call/${callId}/leave`, {});
    }
```

- [ ] **Step 4: Give `end` a silent mode and add the alone deadline**

In `src/app/services/call-session.service.ts`, add the signal next to the other public signals:

```ts
    /**
     * When the server has told us we are the only one left, the moment it will force-end the
     * call. Null whenever that does not apply.
     */
    readonly aloneDeadline = signal<Date | null>(null);
```

Replace `end` (line 80-89):

```ts
    /**
     * @param silent skip the network call because the server already tore this session down
     *               (device takeover, or we are reacting to a `CallEnded` that already happened).
     *               Calling leave again there is a pointless, possibly-erroring request.
     */
    end(silent = false): void {
        const s = this.session();
        if (!s) return;
        // Stop any active local media streams before tearing down
        s.participants.find(p => p.isLocal)?.videoStream?.getTracks().forEach(t => t.stop());
        s.screenShares.find(sh => sh.isLocal)?.stream?.getTracks().forEach(t => t.stop());
        // TODO(webrtc): disconnect all peer connections
        if (!silent) this.voiceService.leaveCall(s.callId).subscribe();
        this.session.set(null);
        this.aloneDeadline.set(null);
    }

    setAloneDeadline(deadline: Date | null): void {
        this.aloneDeadline.set(deadline);
    }
```

At the end of `onParticipantJoined` (line 339), after the `this.session.update(...)` call:

```ts
        this.session.update(st => st ? {...st, participants: [...st.participants, participant]} : st);
        // Someone came back, so the server's force-end countdown no longer applies.
        if ((this.session()?.participants.length ?? 0) > 1) this.aloneDeadline.set(null);
```

- [ ] **Step 5: Switch outgoing-call cancel to leave**

In `src/app/services/call-state.service.ts`, line 119, change:

```ts
            this.voiceService.endCall(this.pendingCallDto.id).subscribe();
```

to:

```ts
            // Cancelling before anyone answers is "the only connected participant leaves", which
            // the server models as leave - dropping to zero ends the call immediately.
            this.voiceService.leaveCall(this.pendingCallDto.id).subscribe();
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun run ng test --watch=false`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/services/voice.service.ts src/app/services/call-session.service.ts src/app/services/call-session.service.spec.ts src/app/services/call-state.service.ts
git commit -m "feat: hang up leaves the call instead of ending it for everyone"
```

---

## Task 10: Per-device call events on the websocket

**Files:**
- Modify: `src/app/services/voice-websocket.service.ts:87-89,93-108,145-162`
- Create: `src/app/services/voice-websocket.service.spec.ts`

**Interfaces:**
- Produces: `WsCallAccepted`, `WsCallDeviceDismissed`, `WsCallDeviceTakeover`, `WsCallParticipantLeft`, `WsCallAlone`; `WsCallEnded.reason`; observables `callAcceptedObservable`, `callDeviceDismissedObservable`, `callDeviceTakeoverObservable`, `callParticipantLeftObservable`, `callAloneObservable`; `describeCallEndedReason(reason?: string): string`. Tasks 11 and 12 consume all of these.

- [ ] **Step 1: Write the failing test**

Create `src/app/services/voice-websocket.service.spec.ts`:

```ts
/**
 * These events are the per-device half of the calls contract. The names must match the server
 * exactly - a typo here is a silent no-op, not an error.
 */
import {TestBed} from '@angular/core/testing';
import {firstValueFrom} from 'rxjs';
import {
    describeCallEndedReason,
    VoiceWebsocketService,
    WsCallDeviceTakeover,
} from './voice-websocket.service';
import {RealtimeConnectionService} from './realtime-connection.service';

function setup() {
    const handlers = new Map<string, (payload: unknown) => void>();
    const realtime = {
        on: vi.fn((event: string, handler: (payload: unknown) => void) => handlers.set(event, handler)),
        off: vi.fn(),
        invoke: vi.fn(),
        start: vi.fn(async () => undefined),
        connectionState: () => 0,
    };

    TestBed.configureTestingModule({
        providers: [{provide: RealtimeConnectionService, useValue: realtime}],
    });

    return {service: TestBed.inject(VoiceWebsocketService), handlers};
}

it.each([
    ['call.CallAccepted', 'callAcceptedObservable'],
    ['call.CallDeviceDismissed', 'callDeviceDismissedObservable'],
    ['call.CallDeviceTakeover', 'callDeviceTakeoverObservable'],
    ['call.CallParticipantLeft', 'callParticipantLeftObservable'],
    ['call.CallAlone', 'callAloneObservable'],
] as const)('relays %s', async (event, observable) => {
    const {service, handlers} = setup();
    await service.start();

    const received = firstValueFrom(service[observable] as never);
    handlers.get(event)!({callId: 'call-1'});

    await expect(received).resolves.toEqual({callId: 'call-1'});
});

it('carries both device ids on a takeover', async () => {
    const {service, handlers} = setup();
    await service.start();

    const received = firstValueFrom(service.callDeviceTakeoverObservable);
    const payload: WsCallDeviceTakeover = {callId: 'c1', oldDeviceId: 'a', newDeviceId: 'b'};
    handlers.get('call.CallDeviceTakeover')!(payload);

    await expect(received).resolves.toEqual(payload);
});

it.each([
    ['Declined', 'Call declined'],
    ['AloneTimeout', 'Call ended - no one rejoined'],
    ['UserEnded', 'Call ended'],
    ['AllParticipantsLeft', 'Call ended'],
    [undefined, 'Call ended'],
])('describes the %s end reason', (reason, expected) => {
    expect(describeCallEndedReason(reason)).toBe(expected);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run ng test --watch=false`
Expected: FAIL - none of the new observables or `describeCallEndedReason` exist.

- [ ] **Step 3: Add the types, observables and registrations**

In `src/app/services/voice-websocket.service.ts`, replace the `WsCallEnded` interface (lines 87-89) with:

```ts
export interface WsCallEnded {
    callId: string;
    reason?: 'Declined' | 'UserEnded' | 'AllParticipantsLeft' | 'AloneTimeout';
}

/** Some device of ours accepted the call - every other ringing device should stop. */
export interface WsCallAccepted {
    callId: string;
    deviceId: string;
}

/** This device's ring was dismissed because another of ours dealt with the call. */
export interface WsCallDeviceDismissed {
    callId: string;
    deviceId: string;
}

/** We joined the call on another device while connected here. */
export interface WsCallDeviceTakeover {
    callId: string;
    oldDeviceId: string;
    newDeviceId: string;
}

/** Application-level departure, distinct from the WebRTC-level `call.ParticipantLeft`. */
export interface WsCallParticipantLeft {
    callId: string;
    userId: string;
}

/** Only one participant is left; the server force-ends the call at `deadline`. */
export interface WsCallAlone {
    callId: string;
    userId: string;
    deadline: string;
}

/** Copy for the toast shown when a call ended for a reason the local user did not cause. */
export function describeCallEndedReason(reason?: string): string {
    switch (reason) {
        case 'Declined':
            return 'Call declined';
        case 'AloneTimeout':
            return 'Call ended - no one rejoined';
        default:
            return 'Call ended';
    }
}
```

Add the observables after `callEndedObservable` (line 106):

```ts
    public callEndedObservable = new Subject<WsCallEnded>();
    public callAcceptedObservable = new Subject<WsCallAccepted>();
    public callDeviceDismissedObservable = new Subject<WsCallDeviceDismissed>();
    public callDeviceTakeoverObservable = new Subject<WsCallDeviceTakeover>();
    public callParticipantLeftObservable = new Subject<WsCallParticipantLeft>();
    public callAloneObservable = new Subject<WsCallAlone>();
```

Add the registrations in `setupListeners` after line 161:

```ts
        this.realtime.on('call.CallEnded', (d: WsCallEnded) => this.callEndedObservable.next(d));

        // ── Per-device call events ──────────────────────────────────────────────
        this.realtime.on('call.CallAccepted', (d: WsCallAccepted) => this.callAcceptedObservable.next(d));
        this.realtime.on('call.CallDeviceDismissed', (d: WsCallDeviceDismissed) => this.callDeviceDismissedObservable.next(d));
        this.realtime.on('call.CallDeviceTakeover', (d: WsCallDeviceTakeover) => this.callDeviceTakeoverObservable.next(d));
        this.realtime.on('call.CallParticipantLeft', (d: WsCallParticipantLeft) => this.callParticipantLeftObservable.next(d));
        this.realtime.on('call.CallAlone', (d: WsCallAlone) => this.callAloneObservable.next(d));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run ng test --watch=false`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/voice-websocket.service.ts src/app/services/voice-websocket.service.spec.ts
git commit -m "feat: relay the per-device call events from the hub"
```

---

## Task 11: Ringing UI reacts to the other devices

**Files:**
- Modify: `src/app/services/call-state.service.ts:41-60,126-132`
- Create: `src/app/services/call-state.service.spec.ts`

**Interfaces:**
- Consumes: the observables from Task 10, `CallSessionService.end(silent)` from Task 9.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Create `src/app/services/call-state.service.spec.ts`:

```ts
/**
 * Bug this fixes: with both devices ringing, declining on one ended the whole call on the other.
 * The ring must now be dismissed by the per-device events rather than by CallEnded alone.
 */
import {TestBed} from '@angular/core/testing';
import {Subject} from 'rxjs';
import {CallStateService} from './call-state.service';
import {CallSessionService} from './call-session.service';
import {VoiceWebsocketService} from './voice-websocket.service';
import {VoiceService} from './voice.service';
import {ProfileService} from './profile.service';
import {ConversationStore} from '../stores/conversation.store';
import {NavigationService} from '../features/main-page/navigation.service';
import {SoundSettingsService} from './sound-settings.service';
import {ToastService} from './toast.service';

function setup() {
    const ws = {
        incomingCallObservable: new Subject(),
        callEndedObservable: new Subject(),
        callAcceptedObservable: new Subject(),
        callDeviceDismissedObservable: new Subject(),
        callDeviceTakeoverObservable: new Subject(),
        participantJoinedObservable: new Subject(),
    };
    const callSession = {session: vi.fn(() => null), end: vi.fn(), join: vi.fn()};
    const toast = {info: vi.fn(), httpError: vi.fn(), success: vi.fn()};

    TestBed.configureTestingModule({
        providers: [
            {provide: VoiceWebsocketService, useValue: ws},
            {provide: CallSessionService, useValue: callSession},
            {provide: VoiceService, useValue: {}},
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'me'})}},
            {provide: ConversationStore, useValue: {entities: () => []}},
            {provide: NavigationService, useValue: {openConversation: vi.fn()}},
            {provide: SoundSettingsService, useValue: {playIncomingRing: vi.fn(), playRingback: vi.fn()}},
            {provide: ToastService, useValue: toast},
        ],
    });

    const service = TestBed.inject(CallStateService);
    service.incomingCall.set({
        call: {id: 'call-1'} as never,
        displayName: 'Alice',
        avatarLabel: 'A',
    });
    return {service, ws, callSession, toast};
}

it('stops ringing when another of my devices accepts', () => {
    const {service, ws} = setup();

    ws.callAcceptedObservable.next({callId: 'call-1', deviceId: 'other'});

    expect(service.incomingCall()).toBeNull();
});

it('stops ringing when the server dismisses this device', () => {
    const {service, ws} = setup();

    ws.callDeviceDismissedObservable.next({callId: 'call-1', deviceId: 'mine'});

    expect(service.incomingCall()).toBeNull();
});

it('ignores events for a different call', () => {
    const {service, ws} = setup();

    ws.callAcceptedObservable.next({callId: 'some-other-call', deviceId: 'other'});

    expect(service.incomingCall()).not.toBeNull();
});

it('tears down the active session on takeover without calling leave', () => {
    const {ws, callSession, toast} = setup();
    callSession.session.mockReturnValue({callId: 'call-1'});

    ws.callDeviceTakeoverObservable.next({callId: 'call-1', oldDeviceId: 'a', newDeviceId: 'b'});

    expect(callSession.end).toHaveBeenCalledWith(true);
    expect(toast.info).toHaveBeenCalledWith('You joined this call on another device');
});

it('ignores a takeover for a call we are not in', () => {
    const {ws, callSession} = setup();
    callSession.session.mockReturnValue({callId: 'another-call'});

    ws.callDeviceTakeoverObservable.next({callId: 'call-1', oldDeviceId: 'a', newDeviceId: 'b'});

    expect(callSession.end).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run ng test --watch=false`
Expected: FAIL - the ring stays up; no subscription handles these events.

- [ ] **Step 3: Add the subscriptions**

In `src/app/services/call-state.service.ts`, add fields next to `incomingEndedSub` (line 42):

```ts
    private incomingEndedSub: Subscription;
    private deviceSubs: Subscription;
```

Replace the `incomingEndedSub` assignment in the constructor (lines 54-58) with:

```ts
        this.incomingEndedSub = this.ws.callEndedObservable.subscribe(({callId}) =>
            this.dismissIncomingIfMatches(callId));

        // Three ways this device's ring stops without it being the one that acted. Without these
        // the card and ringtone persist after another device deals with the call, and a later
        // Accept click silently fails against a call that has moved on.
        this.deviceSubs = new Subscription();
        this.deviceSubs.add(this.ws.callAcceptedObservable.subscribe(({callId}) =>
            this.dismissIncomingIfMatches(callId)));
        this.deviceSubs.add(this.ws.callDeviceDismissedObservable.subscribe(({callId}) =>
            this.dismissIncomingIfMatches(callId)));
        this.deviceSubs.add(this.ws.callDeviceTakeoverObservable.subscribe(({callId}) => {
            if (this.callSession.session()?.callId !== callId) return;
            // The server already moved the session to the other device - calling leave here
            // would drop us out of the call we just joined there.
            this.callSession.end(true);
            this.toast.info('You joined this call on another device');
        }));
```

Add the shared helper as a private method:

```ts
    private dismissIncomingIfMatches(callId: string): void {
        if (this.incomingCall()?.call.id !== callId) return;
        this.stopRingtone();
        this.incomingCall.set(null);
    }
```

Add the teardown in `ngOnDestroy` (line 126-132):

```ts
        this.incomingEndedSub.unsubscribe();
        this.deviceSubs.unsubscribe();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run ng test --watch=false`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/call-state.service.ts src/app/services/call-state.service.spec.ts
git commit -m "fix: dismiss this device's ring when another device takes the call"
```

---

## Task 12: Active call handles departures, the alone timeout and end reasons

**Files:**
- Modify: `src/app/services/call-webrtc.service.ts:785-840`
- Modify: `src/app/features/messaging/components/conversation/call-panel/call-panel.component.ts`
- Modify: `src/app/features/messaging/components/conversation/call-panel/call-panel.component.html:52`
- Create: `src/app/features/messaging/components/conversation/call-panel/alone-countdown.ts`
- Create: `src/app/features/messaging/components/conversation/call-panel/alone-countdown.spec.ts`

**Interfaces:**
- Consumes: `callParticipantLeftObservable`, `callAloneObservable`, `describeCallEndedReason` (Task 10); `CallSessionService.setAloneDeadline`, `.aloneDeadline`, `.end(silent)` (Task 9).
- Produces: `formatAloneNotice(deadline: Date | null): string | null`.

- [ ] **Step 1: Write the failing test**

Create `src/app/features/messaging/components/conversation/call-panel/alone-countdown.spec.ts`:

```ts
import {formatAloneNotice} from './alone-countdown';

it('names the time the call will end', () => {
    const deadline = new Date('2026-07-31T14:35:00Z');
    const expected = deadline.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});

    expect(formatAloneNotice(deadline)).toBe(
        `Waiting for others to rejoin - call ends at ${expected}`,
    );
});

it('has nothing to say when no deadline applies', () => {
    expect(formatAloneNotice(null)).toBeNull();
});

it('ignores an unparseable deadline rather than rendering "Invalid Date"', () => {
    expect(formatAloneNotice(new Date('nonsense'))).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run ng test --watch=false`
Expected: FAIL - cannot resolve `./alone-countdown`.

- [ ] **Step 3: Create the formatter**

Create `src/app/features/messaging/components/conversation/call-panel/alone-countdown.ts`:

```ts
/**
 * Copy for the banner shown while the local user is the only one left in a call and the server
 * is counting down to force-ending it.
 *
 * A wall-clock time rather than a live countdown: the panel has no ticking timer, and "ends at
 * 14:35" answers the only question the user has without one.
 */
export function formatAloneNotice(deadline: Date | null): string | null {
    if (!deadline || Number.isNaN(deadline.getTime())) return null;
    const at = deadline.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    return `Waiting for others to rejoin - call ends at ${at}`;
}
```

- [ ] **Step 4: Wire the new events into `CallWebRtcService`**

In `src/app/services/call-webrtc.service.ts`, extend the existing import on line 8:

```ts
import {ConnectionState, describeCallEndedReason, VoiceWebsocketService} from './voice-websocket.service';
```

Inside `setupWsListeners`, add after the existing `participantLeftObservable` subscription (line 803):

```ts
            // Application-level departure. Handled alongside - not instead of - the WebRTC-level
            // `call.ParticipantLeft`: `onParticipantLeft` is an idempotent array filter, so both
            // firing for one departure is harmless, and which of the two the backend keeps is
            // not knowable from here.
            this.voiceWs.callParticipantLeftObservable.subscribe(e => {
                this.callSession.onParticipantLeft(e.userId);
                this.subscribedAudioUserIds.delete(e.userId);
                this.participantsWithAudio.update(s => {
                    const n = new Set(s);
                    n.delete(e.userId);
                    return n;
                });
            }),

            this.voiceWs.callAloneObservable.subscribe(e => {
                if (e.callId !== this.callId) return;
                this.callSession.setAloneDeadline(new Date(e.deadline));
            }),
```

Replace the `callEndedObservable` subscription (lines 838-840) with:

```ts
            // The server has already ended it, so tear down silently rather than calling leave.
            this.voiceWs.callEndedObservable.subscribe(e => {
                // `wasActive` is what keeps a self-initiated hangup silent: clicking hang up
                // nulls session() synchronously, before any CallEnded broadcast can arrive. So
                // this only speaks up when the call ended for a reason the user didn't cause.
                const wasActive = !!this.callSession.session();
                this.callSession.end(true);
                if (wasActive) this.toast.info(describeCallEndedReason(e.reason));
            }),
```

`ToastService` is not injected into `CallWebRtcService` yet - add it:

```ts
import {ToastService} from './toast.service';
```

```ts
    private toast = inject(ToastService);
```

- [ ] **Step 5: Show the banner in the call panel**

In `call-panel.component.ts`, add the import and a computed:

```ts
import {formatAloneNotice} from './alone-countdown';
```

```ts
    protected aloneNotice = computed(() => formatAloneNotice(this.callSession.aloneDeadline()));
```

In `call-panel.component.html`, add after the connection-problem banner block (after line 52):

```html
        <!-- ── Alone-timeout notice ──────────────────────────────────────────── -->
        @if (aloneNotice(); as notice) {
            <div class="conn-banner conn-banner--warn">
                <svg class="shrink-0" fill="currentColor" height="13" viewBox="0 0 24 24" width="13">
                    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm1 11h-4v-2h2V7h2v6z"/>
                </svg>
                <span>{{ notice }}</span>
            </div>
        }
```

- [ ] **Step 6: Run the tests and the build**

Run: `bun run ng test --watch=false`
Expected: PASS, including the existing call/voice suites.

Run: `bun run ng build --configuration development`
Expected: success - this catches a template reference to a member that does not exist.

- [ ] **Step 7: Manual visual check**

Run the app (`npm run tauri dev`). With the dev shortcut `Ctrl+Alt+C`, open a fake active call. In dev tools, run `ng.getComponent($0)` on the panel, or temporarily hardcode a deadline in `CallSessionService`, and confirm the amber banner renders in line with the existing connection banners and does not shift the participant grid.

- [ ] **Step 8: Commit**

```bash
git add src/app/services/call-webrtc.service.ts src/app/features/messaging/components/conversation/call-panel
git commit -m "feat: react to per-device departures, the alone timeout and end reasons"
```

---

## Task 13: Guild voice - kicked by another device

**Files:**
- Modify: `src/app/services/guild-websocket.service.ts:86-92,334-337,455-466`
- Modify: `src/app/services/voice-channel.service.ts:1-22,45-51,118-130`
- Create: `src/app/services/voice-channel.service.spec.ts`

**Interfaces:**
- Consumes: `VoiceChannelService.doLeave(guildId, channelId, silent)` (existing, `voice-channel.service.ts:380`).
- Produces: `WsKickedByOtherDevice`; `GuildWebsocketService.kickedByOtherDeviceObservable`.

- [ ] **Step 1: Write the failing test**

Create `src/app/services/voice-channel.service.spec.ts`:

```ts
/**
 * Bug this fixes: joining the same channel from a second device did not kick the first, so both
 * fought over one media session and the first device's audio silently broke. The kick is entirely
 * server-driven; the client's only job is to tear down cleanly when told.
 */
import {TestBed} from '@angular/core/testing';
import {of, Subject} from 'rxjs';
import {VoiceChannelService} from './voice-channel.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {GuildVoiceService} from './guild-voice.service';
import {VoiceRTCService} from './voice-rtc.service';
import {ProfileService} from './profile.service';
import {SoundSettingsService} from './sound-settings.service';
import {VoiceEngineService} from './voice-engine.service';
import {ToastService} from './toast.service';

function setup() {
    const ws: Record<string, Subject<unknown>> = {};
    for (const name of [
        'userJoinedVoiceObservable', 'userLeftVoiceObservable', 'guildParticipantJoinedObservable',
        'guildTrackPublishedObservable', 'guildTrackClosedObservable', 'voiceMuteChangedObservable',
        'voiceDeafenChangedObservable', 'voiceCameraChangedObservable',
        'voiceScreenShareStartedObservable', 'voiceScreenShareStoppedObservable',
        'movedToChannelObservable', 'kickedByOtherDeviceObservable',
    ]) ws[name] = new Subject();

    const guildVoice = {leave: vi.fn(() => of(undefined)), getState: vi.fn(() => of({participants: []}))};
    // Every member the service reads at construction time: the two subjects it subscribes to and
    // the pass-through signals it aliases as its own fields.
    const rtc = {
        closeAllTracks: vi.fn(async () => undefined),
        teardown: vi.fn(),
        speakingChanges$: new Subject(),
        screenEnded$: new Subject(),
        rtcState: () => 'connected',
        participantsWithAudio: () => new Set(),
        localVideoStream: () => null,
        localScreenStream: () => null,
        localScreenHasAudio: () => false,
        localScreenAudioMuted: () => false,
        videoStreams: () => new Map(),
        screenStreams: () => new Map(),
        screenAudioMuted: () => new Map(),
    };
    const toast = {info: vi.fn(), success: vi.fn(), httpError: vi.fn()};

    TestBed.configureTestingModule({
        providers: [
            {provide: GuildWebsocketService, useValue: ws},
            {provide: GuildVoiceService, useValue: guildVoice},
            {provide: VoiceRTCService, useValue: rtc},
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'me'}), getCachedByUserId: () => null}},
            {provide: SoundSettingsService, useValue: {playVoiceJoin: vi.fn(), playVoiceLeave: vi.fn()}},
            {provide: VoiceEngineService, useValue: {speaking: () => false}},
            {provide: ToastService, useValue: toast},
        ],
    });

    const service = TestBed.inject(VoiceChannelService);
    service.joinedChannelId.set('chan-1');
    service.joinedGuildId.set('guild-1');
    return {service, ws, guildVoice, rtc, toast};
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));

it('tears down without calling leave - the server already removed us', async () => {
    const {service, ws, guildVoice, rtc, toast} = setup();

    ws['kickedByOtherDeviceObservable'].next({channelId: 'chan-1', guildId: 'guild-1'});
    await tick();

    expect(rtc.teardown).toHaveBeenCalled();
    expect(guildVoice.leave).not.toHaveBeenCalled();
    expect(service.joinedChannelId()).toBeNull();
    expect(service.joinedGuildId()).toBeNull();
    expect(toast.info).toHaveBeenCalledWith('You joined this channel from another device');
});

it('ignores a kick for a channel we are not in', async () => {
    const {service, ws, rtc} = setup();

    ws['kickedByOtherDeviceObservable'].next({channelId: 'other-chan', guildId: 'guild-1'});
    await tick();

    expect(rtc.teardown).not.toHaveBeenCalled();
    expect(service.joinedChannelId()).toBe('chan-1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run ng test --watch=false`
Expected: FAIL - nothing subscribes to `kickedByOtherDeviceObservable`.

- [ ] **Step 3: Add the event to `GuildWebsocketService`**

In `src/app/services/guild-websocket.service.ts`, add the interface next to `WsMovedToChannel` (line 89):

```ts
/** We joined this voice channel from another device, so this one was removed. */
export interface WsKickedByOtherDevice {
    channelId: string;
    guildId: string;
}
```

Add the observable after `movedToChannelObservable` (line 337):

```ts
    public kickedByOtherDeviceObservable = new Subject<WsKickedByOtherDevice>();
```

Add the registration after the `MovedToChannel` line (line 466):

```ts
        this.realtime.on('guild.voice.KickedByOtherDevice', (d: WsKickedByOtherDevice) => this.kickedByOtherDeviceObservable.next(d));
```

- [ ] **Step 4: Handle it in `VoiceChannelService`**

In `src/app/services/voice-channel.service.ts`, add `WsKickedByOtherDevice` to the existing import block from `./guild-websocket.service` (lines 6-18), and add:

```ts
import {ToastService} from './toast.service';
```

Add the injection next to the other injected services:

```ts
    private readonly toast = inject(ToastService);
```

Add the subscription in the constructor after the `movedToChannelObservable` line (line 129):

```ts
        this.guildWsSvc.kickedByOtherDeviceObservable.subscribe(e => void this.onKickedByOtherDevice(e));
```

Add the handler next to the other SignalR handlers (after `doLeave`, around line 397):

```ts
    /**
     * Mirrors `leaveChannel()` with `silent: true` - the server already removed this device when
     * the other one joined, so calling the leave endpoint would only produce a pointless request
     * against a participant record that no longer exists.
     */
    private async onKickedByOtherDevice(e: WsKickedByOtherDevice): Promise<void> {
        if (e.channelId !== this.joinedChannelId()) return;
        const guildId = this.joinedGuildId();
        if (!guildId) return;

        await this.doLeave(guildId, e.channelId, true);
        this.joinedChannelId.set(null);
        this.joinedGuildId.set(null);
        this.joinedChannelName.set(null);
        this.joinedGuildName.set(null);
        this.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false});
        this.toast.info('You joined this channel from another device');
    }
```

- [ ] **Step 5: Run the full suite**

Run: `bun run ng test --watch=false`
Expected: PASS.

Run: `bun run ng build --configuration development`
Expected: success.

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/guild-websocket.service.ts src/app/services/voice-channel.service.ts src/app/services/voice-channel.service.spec.ts
git commit -m "fix: leave the channel cleanly when another device takes it over"
```

---

## Task 14: Verify the cancel-push handling

**Files:**
- Read-only audit, plus whatever fix it turns up.

**Interfaces:** none.

**Why:** guide §4.4. The accepting device is now excluded from the cancel push while its siblings receive it - the reverse of the old behaviour. A call UI that tore down an active call on a cancel push regardless of which device answered will now break in a new way.

- [x] **Step 1: Find the cancel-push path**

- [x] **Step 2: Decide and record**

**Finding (2026-07-31): no change needed.** Nothing in the push path can tear down a call.

`NotificationService.action$` is fed from exactly two places - the Windows `notification-action` Tauri event (`notification.service.ts:115`) and the plugin's `onAction` on every other platform (`notification.service.ts:136`). It has two subscribers: one raises the window (`notification.service.ts:42`), and one reads `event.extra.conversationId` and opens that conversation (`main-page.component.ts:188`). Neither touches `CallStateService` or `CallSessionService`.

Every call-teardown site is SignalR- or user-driven:

| Site | Trigger |
|---|---|
| `call-webrtc.service.ts:706,715` | `syncParticipants()` - authoritative REST fetch on reconnect |
| `call-webrtc.service.ts:819` | `call.CallEnded` handler |
| `call-state.service.ts:70` | `call.CallDeviceTakeover` handler |
| `call-state.service.ts:94` | outgoing-call race resolving to `ended` |
| `call-state.service.ts:193` | dev shortcut Ctrl+Alt+C |
| `call-panel.component.ts:172` | the hang-up button |

Likewise every `incomingCall.set(null)` is either a local action (accept/reject) or `dismissIncomingIfMatches`, which Task 11 drives from `CallEnded`, `CallAccepted` and `CallDeviceDismissed`.

So the hazard guide §4.4 warns about - a sibling device receiving the cancel push and tearing down its own active call - cannot occur here: this client derives all call state from the hub and treats a push purely as a prompt to focus a conversation. Re-check this if a push payload is ever wired into call state.

- [x] **Step 3: Run the full suite** - 864 tests pass.

- [x] **Step 4: Commit** - recorded here rather than in a code commit, since the audit changed no code.

---

## Post-implementation verification

These cannot be checked until the backend deploy. Run them then, in order - the first is the one that would do real damage if wrong.

- [ ] **Rust and webview report the same device.** Join a guild voice channel. The backend must record **one** device for the join, not two. If it records two, the Rust `X-Device-Id` (Task 4) is not reaching the session endpoint and device-takeover detection will kick the user off their own call.
- [ ] `X-Device-Id` is present on call accept/decline/leave, the Cloudflare session create, and guild voice join (dev tools network tab).
- [ ] The hub URL carries `?deviceId=`.
- [ ] Accept a call on device A while B is also ringing: B stops ringing and does **not** end A's call.
- [ ] Join a guild voice channel on device B while A is in it: A leaves cleanly with the toast, B has working audio.
- [ ] Hang up a group call: the call continues for the others.
- [ ] Sign out: the machine stops receiving push.
- [ ] Forget a device in settings: it disappears from the list and is signed out.
- [ ] Send a deliberately wrong `X-Device-Id` (edit `settings.json`'s `mls_device_id` to a random UUID with MLS keys still present, restart): the first call action recovers via re-registration rather than failing.
