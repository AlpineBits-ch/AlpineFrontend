/**
 * Debug helpers exposed as window globals in development mode only.
 * These are registered by main.ts after bootstrap and are never included in
 * production builds (tree-shaken because the call site is guarded by isDevMode()).
 *
 * Available in the devtools console:
 *   __expireToken()          -corrupts the stored access token so the NEXT api
 *                              call returns 401 and triggers the interceptor refresh
 *   __expireTokenConcurrent(n) -does the same but fires n parallel API requests
 *                              immediately so you can observe the concurrent-401 fix
 *   __fireTokenExpiresEvent() -fires the OAuth library's token_expires event
 *                              to test the setupAutomaticSilentRefresh() path
 *   __showTokenState()       -prints current token expiry info to console
 */

import { ApplicationRef } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { OAuthService } from 'angular-oauth2-oidc';
import { VoiceEngineService, VoiceStats } from './app/services/voice-engine.service';

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
      '%c[debug] access_token corrupted -next API call will return 401 and trigger interceptor refresh',
      'color: orange',
    );
  };

  // Same as __expireToken but immediately fires n parallel requests so you can
  // watch the concurrent-401 → single-refresh → all-retry flow in the network tab.
  (window as any).__expireTokenConcurrent = (n = 3): void => {
    localStorage.setItem(TOKEN_KEY, 'debug.expired.token');
    console.log(`%c[debug] Token corrupted -firing ${n} concurrent requests`, 'color: orange');
    // Hit a lightweight authenticated endpoint; adjust if needed.
    for (let i = 0; i < n; i++) {
      http.get('https://api.venta.gg/api/v1/user/me').subscribe({
        next:  () => console.log(`[debug] request ${i + 1} succeeded after refresh`),
        error: (e) => console.error(`[debug] request ${i + 1} failed`, e),
      });
    }
  };

  // Fire the library's internal token_expires event -exercises the
  // setupAutomaticSilentRefresh() code path without waiting for the real timer.
  (window as any).__fireTokenExpiresEvent = (): void => {
    // eventsSubject is protected in the library but accessible at runtime.
    const subject = (oAuth as any)['eventsSubject'];
    if (!subject) {
      console.error('[debug] eventsSubject not found on OAuthService -library version mismatch?');
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

  const voiceEngine = injector.get(VoiceEngineService);

  // Where the voice pipeline actually stops, for the failure that looks like nothing at all: the
  // call connects, subscribes return Ok, the UI says "connected", and no audio moves in either
  // direction. Every stage reports success to the one above it, so the break is only visible as
  // which counters stop advancing. Sampled twice because the deltas are the signal - a call that
  // has been up for a minute has large totals whether or not anything is flowing right now.
  (window as any).__voiceStats = async (seconds = 2): Promise<void> => {
    const before = await voiceEngine.stats();
    if (!before) {
      console.error('[debug] not running under Tauri - there is no Rust engine to ask');
      return;
    }
    if (!before.running) {
      console.warn('[debug] no voice engine is running - join a call first');
      return;
    }

    await new Promise(r => setTimeout(r, seconds * 1000));
    const after = await voiceEngine.stats();
    if (!after?.running) {
      console.warn('[debug] the engine stopped while sampling');
      return;
    }

    const perSecond = (a: number, b: number) => +((b - a) / seconds).toFixed(1);

    console.log(`%c[debug] voice pipeline over ${seconds}s`, 'color: cyan; font-weight: bold');
    console.table({
      'capture frames/s': perSecond(before.framesCaptured, after.framesCaptured),
      'capture RMS': +after.captureRms.toFixed(4),
      'packets encoded/s': perSecond(before.packetsEncoded, after.packetsEncoded),
      'muted': after.muted,
      'gate open': after.gateOpen,
      'playout frames/s': perSecond(before.playoutFrames, after.playoutFrames),
      'mix RMS': +after.mixRms.toFixed(4),
      'deafened': after.deafened,
      'master volume': after.masterVolume,
    });

    console.table(after.publications.map((p, i) => ({
      slot: p.slot,
      peer: p.peerState,
      ice: p.iceState,
      open: p.open,
      'sent/s': perSecond(before.publications[i]?.packetsSent ?? 0, p.packetsSent),
      dropped: p.packetsDropped,
      'writeErr': p.writeErrors,
      tracks: p.tracksOpened,
      'rtpIn/s': perSecond(before.publications[i]?.rtpReceived ?? 0, p.rtpReceived),
      'routed/s': perSecond(before.publications[i]?.rtpRouted ?? 0, p.rtpRouted),
      unmapped: p.rtpUnmapped,
      subscribed: p.subscribed.join(','),
      midRoutes: p.midRoutes.map(([mid, id]) => `${mid}→${id}`).join(' '),
    })));

    if (after.sources.length) console.table(after.sources);
    else console.warn('[debug] no remote sources in the mix - nobody is subscribed');

    // Say where it stops rather than leaving three tables to be read against each other.
    const out: string[] = [];
    if (perSecond(before.framesCaptured, after.framesCaptured) === 0) {
      out.push('the input device is producing no frames');
    } else if (after.captureRms < 0.0005) {
      out.push('the microphone is delivering silence (wrong device, or muted in the OS)');
    } else if (perSecond(before.packetsEncoded, after.packetsEncoded) === 0) {
      out.push(after.muted ? 'muted' : 'the gate is never opening (push-to-talk, or sensitivity)');
    } else if (after.publications.every(p => p.packetsSent === 0)) {
      out.push('packets are encoded but no publication is accepting them');
    } else if (after.publications.some(p => p.peerState !== 'connected')) {
      out.push('packets are being written to a connection that is not connected');
    }

    const inbound: string[] = [];
    const rtpIn = after.publications.reduce((n, p) => n + p.rtpReceived, 0);
    if (!after.publications.some(p => p.subscribed.length)) {
      inbound.push('nobody is subscribed');
    } else if (rtpIn === 0) {
      inbound.push('subscribed, but the SFU has sent no RTP at all');
    } else if (after.publications.some(p => p.rtpUnmapped > 0 && p.rtpRouted === 0)) {
      inbound.push('RTP is arriving but every packet fails the mid lookup');
    } else if (after.sources.every(s => s.bufferedPackets === 0 && s.level === 0)) {
      inbound.push('RTP is routed but the jitter buffers are empty');
    } else if (after.mixRms < 0.0005) {
      inbound.push(after.deafened ? 'deafened' : 'sources have audio but the mix is silent');
    }

    console.log(
      `%c[debug] outbound: ${out[0] ?? 'flowing'}\n[debug] inbound:  ${inbound[0] ?? 'flowing'}`,
      'color: orange',
    );
  };

  console.log(
    '%c[debug] Token helpers loaded:\n' +
    '  __showTokenState()           -print token timing\n' +
    '  __expireToken()              -corrupt token → next call 401s\n' +
    '  __expireTokenConcurrent(n)   -corrupt + fire n parallel requests\n' +
    '  __fireTokenExpiresEvent()    -fire token_expires event directly\n' +
    '  __voiceStats(seconds)        -where the voice pipeline stops (run while in a call)',
    'color: cyan',
  );
}
