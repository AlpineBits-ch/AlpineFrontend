/** Debug helpers exposed as window globals in development mode only, registered by main.ts after bootstrap. */

import {ApplicationRef} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {OAuthService} from 'angular-oauth2-oidc';
import {VoiceEngineService, VoiceStats} from './app/services/voice-engine.service';
import {IsleVoiceRtcService} from './app/services/isle-voice-rtc.service';

const TOKEN_KEY = 'access_token';
const STORED_AT_KEY = 'access_token_stored_at';
const EXPIRES_IN_KEY = 'expires_in';

export function registerDebugHelpers(appRef: ApplicationRef): void {
    const {injector} = appRef;
    const oAuth = injector.get(OAuthService);
    const http = injector.get(HttpClient);

    // Corrupt the stored access token so the next outgoing request returns 401.
    // The refresh_token stays intact so the interceptor can recover.
    (window as any).__expireToken = (): void => {
        localStorage.setItem(TOKEN_KEY, 'debug.expired.token');
        console.log(
            '%c[debug] access_token corrupted: next API call will return 401 and trigger interceptor refresh',
            'color: orange',
        );
    };

    // Same as __expireToken but immediately fires n parallel requests so you can
    // watch the concurrent-401 → single-refresh → all-retry flow in the network tab.
    (window as any).__expireTokenConcurrent = (n = 3): void => {
        localStorage.setItem(TOKEN_KEY, 'debug.expired.token');
        console.log(`%c[debug] Token corrupted: firing ${n} concurrent requests`, 'color: orange');
        // Hit a lightweight authenticated endpoint; adjust if needed.
        for (let i = 0; i < n; i++) {
            http.get('https://api.venta.gg/api/v1/user/me').subscribe({
                next: () => console.log(`[debug] request ${i + 1} succeeded after refresh`),
                error: e => console.error(`[debug] request ${i + 1} failed`, e),
            });
        }
    };

    // Fire the library's internal token_expires event, exercising the
    // setupAutomaticSilentRefresh() code path without waiting for the real timer.
    (window as any).__fireTokenExpiresEvent = (): void => {
        // eventsSubject is protected in the library but accessible at runtime.
        const subject = (oAuth as any)['eventsSubject'];
        if (!subject) {
            console.error('[debug] eventsSubject not found on OAuthService: library version mismatch?');
            return;
        }
        subject.next({type: 'token_expires'});
        console.log('%c[debug] token_expires event fired', 'color: orange');
    };

    // Print current token timing info so you can see how much life is left.
    (window as any).__showTokenState = (): void => {
        const token = localStorage.getItem(TOKEN_KEY);
        const storedAt = parseInt(localStorage.getItem(STORED_AT_KEY) ?? '0', 10);
        const expiresIn = parseInt(localStorage.getItem(EXPIRES_IN_KEY) ?? '0', 10);
        const expiresAt = storedAt + expiresIn * 1000;
        const remaining = Math.round((expiresAt - Date.now()) / 1000);

        console.table({
            'access_token (first 20 chars)': token?.slice(0, 20) ?? '(none)',
            stored_at: new Date(storedAt).toISOString(),
            expires_in: `${expiresIn}s`,
            expires_at: new Date(expiresAt).toISOString(),
            remaining: `${remaining}s`,
            has_refresh_token: !!localStorage.getItem('refresh_token'),
        });
    };

    const voiceEngine = injector.get(VoiceEngineService);

    // Where the voice pipeline actually stops. Sampled twice because the deltas, not the totals, are the signal.
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
            muted: after.muted,
            'gate open': after.gateOpen,
            'playout frames/s': perSecond(before.playoutFrames, after.playoutFrames),
            'mix RMS': +after.mixRms.toFixed(4),
            deafened: after.deafened,
            'master volume': after.masterVolume,
        });

        console.table(
            after.publications.map((p, i) => ({
                slot: p.slot,
                peer: p.peerState,
                ice: p.iceState,
                open: p.open,
                'sent/s': perSecond(before.publications[i]?.packetsSent ?? 0, p.packetsSent),
                dropped: p.packetsDropped,
                writeErr: p.writeErrors,
                tracks: p.tracksOpened,
                'rtpIn/s': perSecond(before.publications[i]?.rtpReceived ?? 0, p.rtpReceived),
                'routed/s': perSecond(before.publications[i]?.rtpRouted ?? 0, p.rtpRouted),
                unmapped: p.rtpUnmapped,
                subscribed: p.subscribed.join(','),
                midRoutes: p.midRoutes.map(([mid, id]) => `${mid}→${id}`).join(' '),
            })),
        );

        for (const p of after.publications) {
            if (p.peerState === 'failed' || p.iceState === 'failed') {
                console.warn(`[debug] ${p.slot} offered these candidates:`, p.localCandidates);
            }
        }

        if (after.sources.length) console.table(after.sources);
        else console.warn('[debug] no remote sources in the mix - nobody is subscribed');

        // Say where it stops, rather than leaving three tables to be read against each other.
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

        // Must be checked before anything else: with no transport every downstream counter reads zero.
        if (after.publications.some(p => p.peerState === 'failed' || p.iceState === 'failed')) {
            console.log(
                '%c[debug] the peer connection failed: no media can flow in either direction, and every\n' +
                    '        other counter below is a consequence of that rather than a separate fault',
                'color: red',
            );
            return;
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

    const isleRtc = injector.get(IsleVoiceRtcService);

    // Which proximity peers we were told to hear versus which we are actually pulling, per peer.
    (window as any).__isleSubs = (): void => {
        const {peers, deferredOrders} = isleRtc.subscribeDiagnostics();
        if (!peers.length) {
            console.warn(
                '[debug] no proximity peers have been ordered: nobody is in earshot, or voice is not joined',
            );
        } else {
            console.table(peers);
        }
        const unpulled = peers.filter(p => !p.pulled);
        if (unpulled.length) {
            console.warn(
                `[debug] ${unpulled.length} peer(s) ordered but not pulled: they are silent AND unplaced:`,
                unpulled.map(p => p.userId),
            );
        }
        if (deferredOrders) {
            console.warn(`[debug] ${deferredOrders} order(s) arrived with no publication and are being held`);
        }
    };

    console.log(
        '%c[debug] Token helpers loaded:\n' +
            '  __showTokenState()           : print token timing\n' +
            '  __expireToken()              : corrupt token → next call 401s\n' +
            '  __expireTokenConcurrent(n)   : corrupt + fire n parallel requests\n' +
            '  __fireTokenExpiresEvent()    : fire token_expires event directly\n' +
            '  __voiceStats(seconds)        : where the voice pipeline stops (run while in a call)\n' +
            '  __isleSubs()                 : proximity peers ordered vs actually pulled',
        'color: cyan',
    );
}
