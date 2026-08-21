/**
 * Push tokens now carry the device they belong to, which is what lets the server leave out the
 * device already dealing with an event. Deregistration is what stops a signed-out handset ringing.
 *
 * <p>The notification plugin and `plugin-os` mocks this file used to carry are gone: the service
 * delegates to the {@link Notifier} port and the tests provide a {@link FakeNotifier}. That is what
 * makes the browser paths testable at all - a module mock of the desktop plugin cannot express "this
 * host mints no token", which is the case that must not break sign-in.</p>
 */
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {SettingsStore, SettingsStoreFactory} from '../platform/ports/settings-store.port';
import {FakeNotifier} from '../platform/testing/fake-notifier';
import {provideFakePlatform} from '../platform/testing/provide-fake-platform';
import {WebSettingsStoreFactory} from '../platform/web/settings-store';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';
import {UserTokenService} from './user-token.service';

const BASE = 'https://api.venta.gg';
const PUSH_URL = `${BASE}/api/v1/identity/users/self/push-token`;

const store = {get: vi.fn(), set: vi.fn(), delete: vi.fn(), save: vi.fn()};

/**
 * The settings backend, provided rather than detected.
 *
 * <p>The `vi.mock('@tauri-apps/plugin-store')` and the `__TAURI_INTERNALS__` global this file used to
 * carry are both gone: `UserTokenService` injects {@link SettingsStoreFactory}, so the backend is a
 * provider. The mock was the last native one here, and its removal is what took this file off the
 * boundary spec's spec-file exemption.</p>
 */
class StubSettingsStoreFactory extends SettingsStoreFactory {
    readonly opened: string[] = [];

    open(file: string): SettingsStore {
        this.opened.push(file);
        return store as unknown as SettingsStore;
    }
}

const settings = new StubSettingsStoreFactory();

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
    settings.opened.length = 0;
    localStorage.clear();
    store.get.mockResolvedValue(null);
    store.set.mockResolvedValue(undefined);
    store.delete.mockResolvedValue(undefined);
    store.save.mockResolvedValue(undefined);
});

function setup(configure?: (notifier: FakeNotifier) => void, backend: SettingsStoreFactory = settings) {
    const notifier = new FakeNotifier();
    configure?.(notifier);

    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideFakePlatform({Notifier: notifier, SettingsStoreFactory: backend}),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device-abc'}},
        ],
    });
    return {
        service: TestBed.inject(UserTokenService),
        ctrl: TestBed.inject(HttpTestingController),
        notifier,
    };
}

it('persists the token through the injected factory, not a backend of its own choosing', async () => {
    // Would pass with the free function still wired up only if this factory were the one it built,
    // which it cannot be: a service that chose its own would leave `opened` empty and write nowhere
    // this test can see.
    const only = new StubSettingsStoreFactory();
    const {service, ctrl} = setup(undefined, only);

    void service.ensureTokenRegistered();
    await tick();
    ctrl.expectOne(PUSH_URL).flush({});
    await tick();

    expect(only.opened).toContain('settings.json');
    expect(store.set).toHaveBeenCalledWith('push_token', {token: 'push-token-xyz', kind: 'Fcm'});
    expect(settings.opened).toEqual([]);
});

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
    const {service, ctrl} = setup(n => {
        n.kind = 'ApnsVoip';
    });

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

it('registers even when the permission prompt was refused', async () => {
    // The permission result has never gated registration, and must not start: a grant and a usable
    // transport token are different things, and a user who dismissed the prompt can still hold a
    // token from an earlier grant. The mint is the gate.
    const {service, ctrl, notifier} = setup(n => {
        n.permissionGranted = false;
    });

    void service.ensureTokenRegistered();
    await tick();

    expect(notifier.permissionRequests).toBe(1);
    ctrl.expectOne(PUSH_URL).flush({});
});

it('swallows a host that cannot mint a token at all', async () => {
    // Desktop Windows, macOS and Linux: the plugin rejects because there is no push backend.
    const {service, ctrl} = setup(n => {
        n.tokenError = new Error('push not supported');
    });

    await expect(service.ensureTokenRegistered()).resolves.toBeUndefined();

    ctrl.expectNone(() => true);
    expect(store.set).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// No push token: the browser, today
// ---------------------------------------------------------------------------

/**
 * <p><b>The case that must not break sign-in, and must not leave a device row behind.</b> On web
 * `Notifier.pushToken()` resolves null - there is no service worker, no VAPID key and no server-side
 * `WebPush` kind - and a null token has to mean "register nothing" rather than "register something
 * empty". A row carrying a `WebPush` kind with no usable endpoint would be chosen as a delivery target
 * and would drop every notification sent to it, which presents as a server fault rather than as a
 * missing feature.</p>
 */
describe('when the host mints no push token', () => {
    it('posts nothing and stores nothing, and still resolves', async () => {
        const {service, ctrl} = setup(n => {
            n.token = null;
            n.kind = 'WebPush';
        });

        await expect(service.ensureTokenRegistered()).resolves.toBeUndefined();

        ctrl.expectNone(() => true);
        expect(store.set).not.toHaveBeenCalled();
        expect(store.save).not.toHaveBeenCalled();
    });

    it('leaves nothing for sign-out to deregister', async () => {
        // The other half of "no half-registered device row": nothing was written, so the logout path
        // finds nothing and sends no DELETE for a registration the server never had.
        const {service, ctrl} = setup(n => {
            n.token = null;
            n.kind = 'WebPush';
        });

        await service.ensureTokenRegistered();
        await service.deregisterToken();

        ctrl.expectNone(() => true);
    });

    it('still asks for permission, because foreground notifications do work', async () => {
        // Web has no push but does have toasts while the tab is open. Skipping the prompt would take
        // those away too.
        const {service, notifier} = setup(n => {
            n.token = null;
            n.kind = 'WebPush';
        });

        await service.ensureTokenRegistered();

        expect(notifier.permissionRequests).toBe(1);
    });

    it('posts nothing when the host reports no transport kind either', async () => {
        const {service, ctrl} = setup(n => {
            n.token = null;
            n.kind = null;
        });

        await expect(service.ensureTokenRegistered()).resolves.toBeUndefined();

        ctrl.expectNone(() => true);
    });
});

// ---------------------------------------------------------------------------
// Outside Tauri
// ---------------------------------------------------------------------------

/**
 * The `localStorage` backend.
 *
 * <p><b>A weaker posture than the Tauri store file.</b> A push token is a capability - it can be used
 * to target this installation, and to delete its registration - and in a browser it is readable by
 * anything on the origin, with no keychain to put it in instead. What keeps that acceptable today is
 * that nothing is written: web mints no token, so the browser branch of this key is exercised only by
 * the deregistration path below, reading a value a desktop session could never have left there. See
 * the note on `PUSH_TOKEN_KEY`, which spells out what changes the day Web Push lands.</p>
 *
 * <p>These pin the *storage* half: that it no longer rejects outside Tauri, and that deregistration
 * can still find and clear a token.</p>
 *
 * <p><b>The real `WebSettingsStoreFactory`, provided</b> - not a host faked by deleting a global. The
 * prefix and the JSON encoding below belong to that adapter, so a fake here would pin nothing.</p>
 */
describe('outside Tauri', () => {
    /** Pinned as a literal, so renaming the shared prefix has to be a deliberate edit here too. */
    const PREFIX = 'alpine_settings::';

    const web = new WebSettingsStoreFactory();

    function browser(configure?: (notifier: FakeNotifier) => void) {
        return setup(configure, web);
    }

    it('reports no stored token, without ever opening the Tauri store', async () => {
        const {service, ctrl} = browser();

        await service.deregisterToken();

        ctrl.expectNone(() => true);
        // The gate is now structural rather than asserted: the service is handed a backend and has
        // no branch that could reach for the other one.
        expect(settings.opened).toEqual([]);
        expect(store.get).not.toHaveBeenCalled();
    });

    it('deregisters a token persisted in localStorage, and clears it', async () => {
        localStorage.setItem(`${PREFIX}push_token`, JSON.stringify({token: 'push-token-xyz', kind: 'Fcm'}));
        const {service, ctrl} = browser();

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
        const {service, ctrl} = browser();

        const done = service.deregisterToken();
        await tick();
        ctrl.expectOne(r => r.method === 'DELETE').flush('nope', {status: 500, statusText: 'Server Error'});

        // Swallowed, so sign-out completes - but the token stays, because forgetting it locally
        // while the server still holds it is how an installation keeps ringing after sign-out.
        await expect(done).resolves.toBeUndefined();
        expect(localStorage.getItem(`${PREFIX}push_token`)).toBe(stored);
    });

    it('reads a corrupt stored token as absent rather than throwing', async () => {
        localStorage.setItem(`${PREFIX}push_token`, 'not json');
        const {service, ctrl} = browser();

        await expect(service.deregisterToken()).resolves.toBeUndefined();

        ctrl.expectNone(() => true);
    });
});
