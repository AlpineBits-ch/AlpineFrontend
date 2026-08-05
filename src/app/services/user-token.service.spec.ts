/**
 * Push tokens now carry the device they belong to, which is what lets the server leave out the
 * device already dealing with an event. Deregistration is what stops a signed-out handset ringing.
 */
// Stubbed true, and re-stubbed true in `beforeEach`, because everything outside the "outside Tauri"
// block below is about the desktop path and would otherwise silently start asserting against
// `localStorage`. `vi.clearAllMocks` clears calls but not implementations, so the flip to false in
// that block would leak into every test after it without the reset.
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
    isTauri: vi.fn(() => true),
}));
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
import {isTauri} from '@tauri-apps/api/core';
import {LazyStore} from '@tauri-apps/plugin-store';
import {type as osType} from '@tauri-apps/plugin-os';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';
import {UserTokenService} from './user-token.service';

const BASE = 'https://api.venta.gg';
const PUSH_URL = `${BASE}/api/v1/identity/users/self/push-token`;

const store = {get: vi.fn(), set: vi.fn(), delete: vi.fn(), save: vi.fn()};

/**
 * This runner's global `localStorage` exists but has no methods on it, so every read and write in
 * the browser-backend tests would silently do nothing and the persistence they exist to prove would
 * be unobservable. Same in-memory stand-in, same reason, as in `device-identity.service.spec.ts`.
 */
const browserStorage = new Map<string, string>();

beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => browserStorage.get(k) ?? null,
            setItem: (k: string, v: string) => void browserStorage.set(k, String(v)),
            removeItem: (k: string) => void browserStorage.delete(k),
            clear: () => browserStorage.clear(),
        },
    });
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTauri).mockReturnValue(true);
    localStorage.clear();
    store.get.mockResolvedValue(null);
    store.set.mockResolvedValue(undefined);
    store.delete.mockResolvedValue(undefined);
    store.save.mockResolvedValue(undefined);
    // A regular function, not an arrow: the service calls `new LazyStore(...)`.
    vi.mocked(LazyStore).mockImplementation(function () {
        return store as unknown as LazyStore;
    });
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

it('swallows a failed registration rather than surfacing it to launch', async () => {
    const {service, ctrl} = setup();

    const done = service.ensureTokenRegistered();
    await tick();
    ctrl.expectOne(PUSH_URL).flush('nope', {status: 500, statusText: 'Server Error'});

    await expect(done).resolves.toBeUndefined();
    expect(store.set).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Outside Tauri
// ---------------------------------------------------------------------------

/**
 * The `localStorage` backend.
 *
 * <p><b>A weaker posture than the Tauri store file, on purpose and only here.</b> A push token is a
 * capability - it can be used to target this installation, and to delete its registration - and in
 * a browser it is readable by anything on the origin, with no keychain to put it in instead. This
 * branch is reachable only when there is no Tauri host, which in practice means the E2E build; the
 * packaged app that ships to users still writes the store file. See the note on `PUSH_TOKEN_KEY`.
 * </p>
 *
 * <p>Push registration itself never gets this far in a browser - `registerForPushNotifications` has
 * no host to answer it - so what these pin is that the *storage* half no longer rejects, and that
 * the deregistration path can still find and clear a token.</p>
 */
describe('outside Tauri', () => {
    /** Pinned as a literal, so renaming the shared prefix has to be a deliberate edit here too. */
    const PREFIX = 'alpine_settings::';

    beforeEach(() => {
        vi.mocked(isTauri).mockReturnValue(false);
    });

    it('reports no stored token, without ever opening the Tauri store', async () => {
        const {service, ctrl} = setup();

        await service.deregisterToken();

        ctrl.expectNone(() => true);
        // The gate is the whole guarantee: no IPC is attempted, so there is nothing to reject.
        expect(LazyStore).not.toHaveBeenCalled();
        expect(store.get).not.toHaveBeenCalled();
    });

    it('deregisters a token persisted in localStorage, and clears it', async () => {
        localStorage.setItem(
            `${PREFIX}push_token`,
            JSON.stringify({token: 'push-token-xyz', kind: 'Fcm'}),
        );
        const {service, ctrl} = setup();

        void service.deregisterToken();
        await tick();

        const req = ctrl.expectOne(r => r.url === PUSH_URL && r.method === 'DELETE');
        expect(req.request.params.get('token')).toBe('push-token-xyz');
        req.flush(null, {status: 204, statusText: 'No Content'});
        await tick();

        // Cleared, not merely blanked: a token left behind would be re-sent on the next sign-out
        // and would fail against a registration the server has already dropped.
        expect(localStorage.getItem(`${PREFIX}push_token`)).toBeNull();
    });

    it('leaves the token in place when the delete request fails', async () => {
        const stored = JSON.stringify({token: 'push-token-xyz', kind: 'Fcm'});
        localStorage.setItem(`${PREFIX}push_token`, stored);
        const {service, ctrl} = setup();

        const done = service.deregisterToken();
        await tick();
        ctrl.expectOne(r => r.method === 'DELETE')
            .flush('nope', {status: 500, statusText: 'Server Error'});

        // Swallowed, so sign-out completes - but the token stays, because forgetting it locally
        // while the server still holds it is how an installation keeps ringing after sign-out.
        await expect(done).resolves.toBeUndefined();
        expect(localStorage.getItem(`${PREFIX}push_token`)).toBe(stored);
    });

    it('reads a corrupt stored token as absent rather than throwing', async () => {
        localStorage.setItem(`${PREFIX}push_token`, 'not json');
        const {service, ctrl} = setup();

        await expect(service.deregisterToken()).resolves.toBeUndefined();

        ctrl.expectNone(() => true);
    });
});
