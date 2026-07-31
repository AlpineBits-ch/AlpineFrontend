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
