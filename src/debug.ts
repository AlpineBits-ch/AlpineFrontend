/**
 * Debug helpers exposed as window globals in development mode only.
 * These are registered by main.ts after bootstrap and are never included in
 * production builds (tree-shaken because the call site is guarded by isDevMode()).
 *
 * Available in the devtools console:
 *   __expireToken()          — corrupts the stored access token so the NEXT api
 *                              call returns 401 and triggers the interceptor refresh
 *   __expireTokenConcurrent(n) — does the same but fires n parallel API requests
 *                              immediately so you can observe the concurrent-401 fix
 *   __fireTokenExpiresEvent() — fires the OAuth library's token_expires event
 *                              to test the setupAutomaticSilentRefresh() path
 *   __showTokenState()       — prints current token expiry info to console
 */

import { ApplicationRef } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { OAuthService } from 'angular-oauth2-oidc';

const TOKEN_KEY = 'access_token';
const STORED_AT_KEY = 'access_token_stored_at';
const EXPIRES_IN_KEY = 'expires_in';

export function registerDebugHelpers(appRef: ApplicationRef): void {
  const { injector } = appRef;
  const oAuth = injector.get(OAuthService);
  const http   = injector.get(HttpClient);

  // Corrupt the stored access token so the next outgoing request returns 401.
  // The refresh_token stays intact so the interceptor can recover.
  (window as any).__expireToken = (): void => {
    localStorage.setItem(TOKEN_KEY, 'debug.expired.token');
    console.log(
      '%c[debug] access_token corrupted — next API call will return 401 and trigger interceptor refresh',
      'color: orange',
    );
  };

  // Same as __expireToken but immediately fires n parallel requests so you can
  // watch the concurrent-401 → single-refresh → all-retry flow in the network tab.
  (window as any).__expireTokenConcurrent = (n = 3): void => {
    localStorage.setItem(TOKEN_KEY, 'debug.expired.token');
    console.log(`%c[debug] Token corrupted — firing ${n} concurrent requests`, 'color: orange');
    // Hit a lightweight authenticated endpoint; adjust if needed.
    for (let i = 0; i < n; i++) {
      http.get('https://api.venta.gg/api/v1/user/me').subscribe({
        next:  () => console.log(`[debug] request ${i + 1} succeeded after refresh`),
        error: (e) => console.error(`[debug] request ${i + 1} failed`, e),
      });
    }
  };

  // Fire the library's internal token_expires event — exercises the
  // setupAutomaticSilentRefresh() code path without waiting for the real timer.
  (window as any).__fireTokenExpiresEvent = (): void => {
    // eventsSubject is protected in the library but accessible at runtime.
    const subject = (oAuth as any)['eventsSubject'];
    if (!subject) {
      console.error('[debug] eventsSubject not found on OAuthService — library version mismatch?');
      return;
    }
    subject.next({ type: 'token_expires' });
    console.log('%c[debug] token_expires event fired', 'color: orange');
  };

  // Print current token timing info so you can see how much life is left.
  (window as any).__showTokenState = (): void => {
    const token     = localStorage.getItem(TOKEN_KEY);
    const storedAt  = parseInt(localStorage.getItem(STORED_AT_KEY) ?? '0', 10);
    const expiresIn = parseInt(localStorage.getItem(EXPIRES_IN_KEY) ?? '0', 10);
    const expiresAt = storedAt + expiresIn * 1000;
    const remaining = Math.round((expiresAt - Date.now()) / 1000);

    console.table({
      'access_token (first 20 chars)': token?.slice(0, 20) ?? '(none)',
      'stored_at': new Date(storedAt).toISOString(),
      'expires_in': `${expiresIn}s`,
      'expires_at': new Date(expiresAt).toISOString(),
      'remaining': `${remaining}s`,
      'has_refresh_token': !!localStorage.getItem('refresh_token'),
    });
  };

  console.log(
    '%c[debug] Token helpers loaded:\n' +
    '  __showTokenState()           — print token timing\n' +
    '  __expireToken()              — corrupt token → next call 401s\n' +
    '  __expireTokenConcurrent(n)   — corrupt + fire n parallel requests\n' +
    '  __fireTokenExpiresEvent()    — fire token_expires event directly',
    'color: cyan',
  );
}
