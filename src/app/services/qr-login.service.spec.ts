import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {OAuthService} from 'angular-oauth2-oidc';
import {QrLoginService, QrPollResult} from './qr-login.service';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';

const BASE = 'https://api.venta.gg';
const STATUS_URL = `${BASE}/api/v1/identity/qr-login/status/abc`;
const START_URL = `${BASE}/api/v1/identity/qr-login/start`;

function setup(deviceId: () => Promise<string> = async () => 'device-abc') {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: OAuthService, useValue: {fetchTokenUsingGrant: vi.fn()}},
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: DeviceIdentityService, useValue: {deviceId}},
        ],
    });

    return {
        service: TestBed.inject(QrLoginService),
        http: TestBed.inject(HttpTestingController),
    };
}

describe('QrLoginService.start', () => {
    const tick = () => new Promise<void>(r => setTimeout(r, 0));

    it('carries the client device id into the pairing', async () => {
        const {service, http} = setup();

        service.start().subscribe();
        await tick();

        const req = http.expectOne(START_URL);
        expect(req.request.body.clientDeviceId).toBe('device-abc');
        expect(req.request.body.deviceName).toBeTruthy();
        req.flush({code: 'ABC123', expiresInSeconds: 180});
        http.verify();
    });

    it('still mints a code when the device id cannot be resolved', async () => {
        const {service, http} = setup(async () => {
            throw new Error('store locked');
        });

        service.start().subscribe();
        await tick();

        const req = http.expectOne(START_URL);
        expect(req.request.body.clientDeviceId).toBeUndefined();
        req.flush({code: 'ABC123', expiresInSeconds: 180});
        http.verify();
    });
});

describe('QrLoginService.status', () => {
    /**
     * Regression guard. The server serializes the status PascalCase while the API guide
     * documents it lowercase; comparing the raw value never matched `approved`, so an
     * approved pairing polled forever and the token exchange never ran.
     */
    it.each([
        ['Pending', 'pending'],
        ['Scanned', 'scanned'],
        ['Approved', 'approved'],
        ['Denied', 'denied'],
    ])('maps wire status %s to %s', (wire, expected) => {
        const {service, http} = setup();
        let result: QrPollResult | undefined;

        service.status('abc').subscribe(s => (result = s));
        http.expectOne(STATUS_URL).flush({status: wire});

        expect(result).toBe(expected);
        http.verify();
    });

    it('accepts the lowercase form the API guide documents', () => {
        const {service, http} = setup();
        let result: QrPollResult | undefined;

        service.status('abc').subscribe(s => (result = s));
        http.expectOne(STATUS_URL).flush({status: 'approved'});

        expect(result).toBe('approved');
        http.verify();
    });

    it('reports an aged-out code as expired rather than erroring', () => {
        const {service, http} = setup();
        let result: QrPollResult | undefined;
        let errored = false;

        service.status('abc').subscribe({
            next: s => (result = s),
            error: () => (errored = true),
        });
        http.expectOne(STATUS_URL).flush('gone', {status: 404, statusText: 'Not Found'});

        expect(result).toBe('expired');
        expect(errored).toBe(false);
        http.verify();
    });
});
