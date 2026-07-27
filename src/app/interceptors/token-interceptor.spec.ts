/**
 * Tests for tokenInterceptor -focuses on the concurrent-401 scenario that
 * previously caused the app to freeze/logout prematurely.
 *
 * Bug (before fix):
 *   When N requests all return 401 while a refresh is already in-flight,
 *   the interceptor called softLogout() for each of the N-1 "extra" 401s
 *   instead of queueing them.  Two simultaneous router.navigate() calls
 *   corrupted Angular's navigation state, causing the UI to freeze.
 *
 * Expected behaviour (after fix):
 *   All concurrent 401s share a single refresh Promise.
 *   softLogout() fires at most once (on refresh failure), never on
 *   concurrent-401 collisions.
 */

import {HttpClient, provideHttpClient, withInterceptors} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {OAuthService} from 'angular-oauth2-oidc';
import {Router} from '@angular/router';
import {_resetInterceptorState, tokenInterceptor} from './token-interceptor';
import {ApiConfigService} from '../services/api-config.service';

const API = 'https://api.venta.gg/test';

function setup() {
    const oAuth = {
        getAccessToken: vi.fn(() => 'old-token') as ReturnType<typeof vi.fn>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        refreshToken: vi.fn() as any,
        logOut: vi.fn(),
    };
    const router = {navigate: vi.fn()};

    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(withInterceptors([tokenInterceptor])),
            provideHttpClientTesting(),
            {provide: OAuthService, useValue: oAuth},
            {provide: Router, useValue: router},
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.venta.gg'}},
        ],
    });

    return {
        http: TestBed.inject(HttpClient),
        ctrl: TestBed.inject(HttpTestingController),
        oAuth,
        router,
    };
}

function flush401(ctrl: HttpTestingController) {
    ctrl.match(API).forEach(r => r.flush('Unauthorized', {status: 401, statusText: 'Unauthorized'}));
}

function tick() {
    return new Promise<void>(r => setTimeout(r, 0));
}

beforeEach(() => {
    _resetInterceptorState();
    vi.clearAllMocks();
});

afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

it('retries the request with the new token after a successful refresh', async () => {
    const {http, ctrl, oAuth} = setup();

    let resolve!: () => void;
    oAuth.refreshToken.mockReturnValue(new Promise<void>(r => (resolve = r)));

    let result: unknown;
    http.get(API).subscribe(r => (result = r));

    // 401 triggers refresh
    flush401(ctrl);
    await tick();

    // Refresh completes, retry goes out with new token
    oAuth.getAccessToken.mockReturnValue('new-token');
    resolve();
    await tick();

    const [retry] = ctrl.match(API);
    expect(retry.request.headers.get('Authorization')).toBe('Bearer new-token');
    retry.flush({ok: true});
    await tick();

    expect(result).toEqual({ok: true});
    expect(oAuth.logOut).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Core bug: concurrent 401s
// ---------------------------------------------------------------------------

it('does NOT call softLogout for concurrent 401s while refresh is in-flight', async () => {
    const {http, ctrl, oAuth, router} = setup();

    let resolve!: () => void;
    oAuth.refreshToken.mockReturnValue(new Promise<void>(r => (resolve = r)));

    // Three simultaneous requests
    http.get(API).subscribe({
        next: () => {
        }, error: () => {
        }
    });
    http.get(API).subscribe({
        next: () => {
        }, error: () => {
        }
    });
    http.get(API).subscribe({
        next: () => {
        }, error: () => {
        }
    });

    // All three return 401
    flush401(ctrl);
    await tick();

    // Refresh must have been called exactly once
    expect(oAuth.refreshToken).toHaveBeenCalledTimes(1);
    // No premature logout
    expect(oAuth.logOut).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();

    // Complete the refresh
    oAuth.getAccessToken.mockReturnValue('new-token');
    resolve();
    await tick();

    // All three retry requests must appear
    const retries = ctrl.match(API);
    expect(retries).toHaveLength(3);
    retries.forEach(r => {
        expect(r.request.headers.get('Authorization')).toBe('Bearer new-token');
        r.flush({ok: true});
    });
    await tick();

    // Still no logout
    expect(oAuth.logOut).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Refresh failure
// ---------------------------------------------------------------------------

it('calls softLogout exactly once when the refresh fails, regardless of concurrent 401 count', async () => {
    const {http, ctrl, oAuth, router} = setup();

    let reject!: (e: unknown) => void;
    oAuth.refreshToken.mockReturnValue(new Promise<void>((_, r) => (reject = r)));

    http.get(API).subscribe({
        next: () => {
        }, error: () => {
        }
    });
    http.get(API).subscribe({
        next: () => {
        }, error: () => {
        }
    });
    http.get(API).subscribe({
        next: () => {
        }, error: () => {
        }
    });

    flush401(ctrl);
    await tick();

    reject(new Error('network error'));
    await tick();

    expect(oAuth.logOut).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/authentication']);
});

// ---------------------------------------------------------------------------
// Still-401 after refresh
// ---------------------------------------------------------------------------

it('calls softLogout when the retry request itself returns 401', async () => {
    const {http, ctrl, oAuth, router} = setup();

    let resolve!: () => void;
    oAuth.refreshToken.mockReturnValue(new Promise<void>(r => (resolve = r)));

    http.get(API).subscribe({
        next: () => {
        }, error: () => {
        }
    });

    flush401(ctrl);
    await tick();

    oAuth.getAccessToken.mockReturnValue('new-token');
    resolve();
    await tick();

    // Retry also returns 401 (dead session)
    ctrl.match(API).forEach(r => r.flush('Unauthorized', {status: 401, statusText: 'Unauthorized'}));
    await tick();

    expect(oAuth.logOut).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/authentication']);
});

// ---------------------------------------------------------------------------
// Non-API requests pass through untouched
// ---------------------------------------------------------------------------

it('passes through requests not targeting the API origin', async () => {
    const {http, ctrl, oAuth} = setup();

    http.get('https://other.example.com/data').subscribe();
    ctrl.expectOne('https://other.example.com/data').flush('ok');

    expect(oAuth.refreshToken).not.toHaveBeenCalled();
    expect(oAuth.logOut).not.toHaveBeenCalled();
});
