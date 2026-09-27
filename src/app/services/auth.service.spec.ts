/**
 * The session minted at /connect/token is what `DELETE /sessions/{id}` later uses to find and
 * kill this device's push. That link only exists if the token request carries the device id.
 */
import {TestBed} from '@angular/core/testing';
import {firstValueFrom} from 'rxjs';
import {HttpErrorResponse, provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {OAuthService} from 'angular-oauth2-oidc';
import {AuthService} from './auth.service';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';

function configure(deviceId: () => Promise<string>) {
    const oauth = {
        // Parameters are declared so `mock.calls[0]` is typed and the assertions need no cast.
        fetchTokenUsingGrant: vi.fn(async (_grant: string, _params: Record<string, string>) => ({
            access_token: 'tok',
        })),
        configure: vi.fn(),
    };

    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: OAuthService, useValue: oauth},
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.venta.gg'}},
            {provide: DeviceIdentityService, useValue: {deviceId}},
        ],
    });

    return {service: TestBed.inject(AuthService), oauth};
}

function setup() {
    return configure(async () => 'device-abc');
}

it('sends the device id and a device label at token exchange', async () => {
    const {service, oauth} = setup();

    await firstValueFrom(service.login('alice', 'hunter2'));

    const [grant, params] = oauth.fetchTokenUsingGrant.mock.calls[0];
    expect(grant).toBe('password');
    expect(params['username']).toBe('alice');
    expect(params['device_id']).toBe('device-abc');
    expect(params['device_name']).toBeTruthy();
    expect(params['device_type']).toBeTruthy();
});

it('still logs in when the device id cannot be resolved', async () => {
    const {service, oauth} = configure(async () => {
        throw new Error('store locked');
    });

    await firstValueFrom(service.login('alice', 'hunter2'));

    const [, params] = oauth.fetchTokenUsingGrant.mock.calls[0];
    expect(params['device_id']).toBeUndefined();
    expect(params['username']).toBe('alice');
});

// The server resolves a username or an email itself. Splitting on `@` here used to re-point the
// whole client at the mail host.
it('sends an email identity to the server whole', async () => {
    const {service, oauth} = setup();

    await firstValueFrom(service.login('ada@fastmail.com', 'hunter2'));

    const [, params] = oauth.fetchTokenUsingGrant.mock.calls[0];
    expect(params['username']).toBe('ada@fastmail.com');
});

it('passes the mfa code through unchanged', async () => {
    const {service, oauth} = setup();

    await firstValueFrom(service.login('alice', 'hunter2', '123456'));

    const [, params] = oauth.fetchTokenUsingGrant.mock.calls[0];
    expect(params['mfa_code']).toBe('123456');
});

describe('isLoggedIn with an expired access token', () => {
    function expired(refresh: () => Promise<void>, refreshToken: string | null = 'refresh-token') {
        const {service, oauth} = setup();
        Object.assign(oauth, {
            hasValidAccessToken: vi.fn(() => false),
            getRefreshToken: vi.fn(() => refreshToken),
            refreshToken: vi.fn(refresh),
            getAccessToken: vi.fn(() => 'tok'),
        });
        return service;
    }

    it('stays signed in when the refresh cannot reach the server', async () => {
        const service = expired(() => Promise.reject(new HttpErrorResponse({status: 0})));
        expect(await service.isLoggedIn()).toBe(true);
    });

    it('stays signed in when the token endpoint answers 503', async () => {
        const service = expired(() => Promise.reject(new HttpErrorResponse({status: 503})));
        expect(await service.isLoggedIn()).toBe(true);
    });

    it('is signed out when the server refuses the refresh token', async () => {
        const service = expired(() => Promise.reject(new HttpErrorResponse({status: 400})));
        expect(await service.isLoggedIn()).toBe(false);
    });

    it('is signed out with no refresh token at all', async () => {
        const service = expired(() => Promise.resolve(), null);
        expect(await service.isLoggedIn()).toBe(false);
    });
});
