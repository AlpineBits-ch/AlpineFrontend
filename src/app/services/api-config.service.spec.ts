import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {OAuthService} from 'angular-oauth2-oidc';
import {ApiConfigService} from './api-config.service';

const HOME = 'https://api.venta.gg';

/** This runner's `localStorage` global has no methods, so without a stand-in every write no-ops. */
const localStore = new Map<string, string>();

beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => localStore.get(k) ?? null,
            setItem: (k: string, v: string) => void localStore.set(k, String(v)),
            removeItem: (k: string) => void localStore.delete(k),
            clear: () => localStore.clear(),
        },
    });
});

function setup() {
    const oauth = {configure: vi.fn()};

    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: OAuthService, useValue: oauth},
        ],
    });

    return {service: TestBed.inject(ApiConfigService), oauth};
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('ApiConfigService.setServer', () => {
    it('maps the home domain back to the compiled-in API host', () => {
        const {service} = setup();

        service.setServer('venta.gg');

        expect(service.baseUrl()).toBe(HOME);
    });

    it('treats any other domain as its own https origin', () => {
        const {service} = setup();

        service.setServer('rp.thornwood.net');

        expect(service.baseUrl()).toBe('https://rp.thornwood.net');
    });

    it('writes both the slot-scoped key and the shared last-server-used', () => {
        const {service} = setup();

        service.setServer('rp.thornwood.net');

        expect(localStorage.getItem('server_url')).toBe('https://rp.thornwood.net');
        expect(localStorage.getItem('@bootstrap::server_url')).toBe('https://rp.thornwood.net');
    });

    it('re-points the OAuth issuer and token endpoint', () => {
        const {service, oauth} = setup();

        service.setServer('rp.thornwood.net');

        const config = oauth.configure.mock.calls.at(-1)![0];
        expect(config.issuer).toBe('https://rp.thornwood.net');
        expect(config.tokenEndpoint).toBe('https://rp.thornwood.net/connect/token');
    });
});

describe('ApiConfigService.urlToDomain', () => {
    it('answers the home domain for the compiled-in API host', () => {
        expect(ApiConfigService.urlToDomain(HOME)).toBe('venta.gg');
    });

    it('round-trips a self-hosted domain through domainToUrl', () => {
        const url = ApiConfigService.domainToUrl('rp.thornwood.net');

        expect(ApiConfigService.urlToDomain(url)).toBe('rp.thornwood.net');
    });

    it('keeps a non-default port, which is part of the origin', () => {
        expect(ApiConfigService.urlToDomain('https://self.example:8443')).toBe('self.example:8443');
    });

    it('falls back to the home domain for a value that is not a URL', () => {
        expect(ApiConfigService.urlToDomain('not a url')).toBe('venta.gg');
    });
});

describe('ApiConfigService startup', () => {
    it('prefers the slot-scoped server over the shared one', () => {
        localStorage.setItem('alpine_active_account', 'slot-a');
        localStorage.setItem('slot-a::server_url', 'https://rp.thornwood.net');
        localStorage.setItem('server_url', 'https://chat.kestrel.dev');

        const {service} = setup();

        expect(service.baseUrl()).toBe('https://rp.thornwood.net');
    });

    // Add Account sets the live slot aside, so the scoped read misses on purpose and the shared key
    // is what carries the login screen's last-server-used.
    it('falls back to the shared server when the slot has none', () => {
        localStorage.setItem('alpine_active_account', 'slot-b');
        localStorage.setItem('server_url', 'https://chat.kestrel.dev');

        const {service} = setup();

        expect(service.baseUrl()).toBe('https://chat.kestrel.dev');
    });
});

describe('ApiConfigService.reset', () => {
    it('clears this slot and the shared key but leaves other slots alone', () => {
        localStorage.setItem('alpine_active_account', 'slot-a');
        localStorage.setItem('slot-a::server_url', 'https://rp.thornwood.net');
        localStorage.setItem('slot-b::server_url', 'https://chat.kestrel.dev');
        localStorage.setItem('server_url', 'https://rp.thornwood.net');

        const {service} = setup();
        service.reset();

        expect(service.baseUrl()).toBe(HOME);
        expect(localStorage.getItem('slot-a::server_url')).toBeNull();
        expect(localStorage.getItem('server_url')).toBeNull();
        expect(localStorage.getItem('slot-b::server_url')).toBe('https://chat.kestrel.dev');
    });
});
