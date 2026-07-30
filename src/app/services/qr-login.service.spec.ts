import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {OAuthService} from 'angular-oauth2-oidc';
import {QrLoginService, QrPollResult} from './qr-login.service';
import {ApiConfigService} from './api-config.service';

const BASE = 'https://api.venta.gg';
const STATUS_URL = `${BASE}/api/v1/identity/qr-login/status/abc`;

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: OAuthService, useValue: {fetchTokenUsingGrant: vi.fn()}},
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    });

    return {
        service: TestBed.inject(QrLoginService),
        http: TestBed.inject(HttpTestingController),
    };
}

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
