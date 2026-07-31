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
