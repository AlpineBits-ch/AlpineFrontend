/**
 * The Isle proximity subscribe path: retry, dedupe and backfill.
 *
 * <p>Every assertion here is about the same failure: a peer who is ordered audible and not pulled is
 * <b>silent AND unplaced for the rest of the session</b>, because `isle.SubscribeMutual` is the only
 * thing that establishes either and the relay will not repeat it while the pair stays audible
 * (`VoiceSubscriptionReconcileService` records a pair as pushed whatever the client made of it). So
 * these are not "audio is a bit degraded" tests - each one guards a permanent one-way silence.</p>
 *
 * <p>The engine is the real {@link VoiceEngineService} over a {@link FakeVoicePublisher}, rather than a
 * stubbed engine. That is deliberate: the port is where "already subscribed" is decided, and a stubbed
 * engine would let a test assert that a subscribe was *issued* while proving nothing about whether the
 * pull could reach the wire - which is precisely the trap the session-id dedupe test below exists for.</p>
 */
import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {OAuthService} from 'angular-oauth2-oidc';
import {FakeVoicePublisher} from '../platform/testing/fake-voice-publisher';
import {VoicePublisher} from '../platform/ports/voice-publisher.port';
import {AudioSettings, AudioSettingsService} from './audio-settings.service';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';
import {SpatialAudioService} from './spatial-audio.service';
import {ISLE_SUBSCRIBE_RETRY_DELAYS_MS, IsleVoiceRtcService} from './isle-voice-rtc.service';

/**
 * Records the two calls that decide whether a peer is *placed*.
 *
 * Stubbed rather than real because the coordinate maths has its own tests and starts a 20 Hz timer;
 * what matters here is that placement happens exactly when a pull succeeded and not before.
 */
class FakeSpatial {
    readonly added: string[] = [];
    readonly removed: string[] = [];
    resets = 0;

    addPeer(userId: string): void {
        this.added.push(userId);
    }

    removePeer(userId: string): void {
        this.removed.push(userId);
    }

    reset(): void {
        this.resets++;
    }

    setMasterVolume(): void { /* not under test */
    }

    setSpatialEnabled(): void { /* not under test */
    }

    async setOutputDevice(): Promise<void> { /* not under test */
    }
}

let rtc: IsleVoiceRtcService;
let publisher: FakeVoicePublisher;
let spatial: FakeSpatial;

/** Every subscribe the port saw, as `id@session`, so order and repetition are both visible. */
function pulls(): string[] {
    return publisher.subscribed.map(s => `${s.id}@${s.mediaSessionId}`);
}

beforeEach(() => {
    vi.useFakeTimers();
    publisher = new FakeVoicePublisher();
    spatial = new FakeSpatial();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            {provide: VoicePublisher, useValue: publisher},
            {provide: SpatialAudioService, useValue: spatial},
            {provide: AudioSettingsService, useValue: {settings: signal({} as AudioSettings)}},
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.example.test'}},
            {provide: OAuthService, useValue: {getAccessToken: () => 'tok'}},
            {provide: DeviceIdentityService, useValue: {deviceId: async () => 'dev-1'}},
        ],
    });
    rtc = TestBed.inject(IsleVoiceRtcService);
});

describe('an order that arrives before the publication exists', () => {
    it('is held and drained rather than dropped', async () => {
        // The relay pushes SubscribeMutual for every already-audible peer from inside the tracks/new
        // that publishes our own microphone - so on a join next to people who are already standing
        // there, these arrive before there is anything to pull them onto. Dropping one made that peer
        // permanently inaudible and permanently unplaced.
        const order = rtc.subscribeToPeer('u1', 'peer-session-1', 'audio');
        await vi.advanceTimersByTimeAsync(0);
        await order;

        expect(pulls(), 'nothing can be pulled before there is a publication').toEqual([]);

        expect(await rtc.connect()).toBe(true);
        await vi.advanceTimersByTimeAsync(0);

        expect(pulls()).toEqual(['u1@peer-session-1']);
        expect(rtc.peers().has('u1')).toBe(true);
        expect(spatial.added).toEqual(['u1']);
    });

    it('is held for every peer in the block, not just the last one', async () => {
        // A busy cell orders the whole block at once. A backfill that only remembered one would look
        // like it worked and still leave most of the block silent.
        for (const id of ['u1', 'u2', 'u3']) void rtc.subscribeToPeer(id, `s-${id}`, 'audio');
        await vi.advanceTimersByTimeAsync(0);

        await rtc.connect();
        await vi.advanceTimersByTimeAsync(0);

        expect(pulls().sort()).toEqual(['u1@s-u1', 'u2@s-u2', 'u3@s-u3']);
    });

    it('is not drained onto a publication that failed to open', async () => {
        publisher.startError = new Error('no microphone');
        void rtc.subscribeToPeer('u1', 'peer-session-1', 'audio');
        await vi.advanceTimersByTimeAsync(0);

        expect(await rtc.connect()).toBe(false);
        await vi.advanceTimersByTimeAsync(0);

        expect(pulls()).toEqual([]);
    });
});

describe('a pull that fails', () => {
    it('is retried on the documented backoff and then succeeds', async () => {
        await rtc.connect();
        publisher.subscribeError = new Error('not_found_track_error');

        const order = rtc.subscribeToPeer('u1', 'peer-session-1', 'audio');
        await vi.advanceTimersByTimeAsync(0);
        expect(pulls()).toEqual(['u1@peer-session-1']);
        expect(rtc.peers().has('u1'), 'a failed pull must not be recorded as one').toBe(false);

        // A tight loop against the signalling relay is its own bug - incident VNT-GE21R3P7. Nothing
        // may be reattempted before the first delay elapses.
        await vi.advanceTimersByTimeAsync(ISLE_SUBSCRIBE_RETRY_DELAYS_MS[0] - 1);
        expect(pulls()).toHaveLength(1);

        publisher.subscribeError = null;
        await vi.advanceTimersByTimeAsync(1);
        await order;

        expect(pulls()).toEqual(['u1@peer-session-1', 'u1@peer-session-1']);
        expect(rtc.peers().has('u1')).toBe(true);
        expect(spatial.added).toEqual(['u1']);
    });

    it('gives up after the schedule rather than looping, and does not claim the peer', async () => {
        await rtc.connect();
        publisher.subscribeError = new Error('the SFU refused the pull');

        const order = rtc.subscribeToPeer('u1', 'peer-session-1', 'audio');
        // Well past the whole schedule: a loop with no bound would keep going.
        await vi.advanceTimersByTimeAsync(60_000);
        await order;

        expect(pulls()).toHaveLength(ISLE_SUBSCRIBE_RETRY_DELAYS_MS.length + 1);
        expect(rtc.peers().has('u1')).toBe(false);
        expect(spatial.added, 'an unpulled peer must not be placed').toEqual([]);
        // Left standing, so a republish or hub reconnect gets to try again rather than treating the
        // peer as handled.
        expect(rtc.subscribeDiagnostics().peers).toEqual([{
            userId: 'u1',
            peerSessionId: 'peer-session-1',
            trackName: 'audio',
            pulled: false,
            attempts: ISLE_SUBSCRIBE_RETRY_DELAYS_MS.length + 1,
            lastError: 'Error: the SFU refused the pull',
        }]);
    });

    it('stops retrying once the peer has left', async () => {
        // Without this, someone who walks out of earshot during a backoff is pulled back in seconds
        // later and stays in the mix with nothing left to remove them.
        await rtc.connect();
        publisher.subscribeError = new Error('not_found_track_error');

        const order = rtc.subscribeToPeer('u1', 'peer-session-1', 'audio');
        await vi.advanceTimersByTimeAsync(0);
        expect(pulls()).toHaveLength(1);

        rtc.tearDownPeer('u1');
        publisher.subscribeError = null;
        await vi.advanceTimersByTimeAsync(60_000);
        await order;

        expect(pulls(), 'a retry outlived the peer it was for').toHaveLength(1);
        expect(rtc.peers().has('u1')).toBe(false);
    });
});

describe('dedupe', () => {
    it('skips a repeated order for the same peer session', async () => {
        await rtc.connect();

        await rtc.subscribeToPeer('u1', 'peer-session-1', 'audio');
        await rtc.subscribeToPeer('u1', 'peer-session-1', 'audio');
        await vi.advanceTimersByTimeAsync(0);

        expect(pulls()).toEqual(['u1@peer-session-1']);
    });

    it('resubscribes when the peer comes back on a new session, dropping the old pull first', async () => {
        // The trap this exists for: the engine's own "already subscribed" guard is keyed on the peer
        // alone and answers success for any source it already holds with a mid route, without looking
        // at the session it was asked for. A peer who republishes keeps their userId and their track
        // name and changes only their session - so dedupe keyed on the peer, here or below, turns the
        // legitimate resubscribe into the same permanent silence by a different route. The unsubscribe
        // has to come *first*, or the new pull never reaches the wire.
        await rtc.connect();
        await rtc.subscribeToPeer('u1', 'peer-session-1', 'audio');
        await vi.advanceTimersByTimeAsync(0);

        await rtc.subscribeToPeer('u1', 'peer-session-2', 'audio');
        await vi.advanceTimersByTimeAsync(0);

        expect(pulls()).toEqual(['u1@peer-session-1', 'u1@peer-session-2']);
        expect(publisher.unsubscribed.map(([, id]) => id)).toEqual(['u1']);
        // Order, not just presence.
        const dropAt = publisher.calls.findIndex(c => c[0] === 'unsubscribe');
        const secondPullAt = publisher.calls.findIndex(c => c[0] === 'subscribe' && c[3] === 'peer-session-2');
        expect(dropAt).toBeGreaterThan(-1);
        expect(dropAt).toBeLessThan(secondPullAt);
        expect(rtc.peers().has('u1')).toBe(true);
    });

    it('resubscribes a peer who walked out of earshot and came back', async () => {
        await rtc.connect();
        await rtc.subscribeToPeer('u1', 'peer-session-1', 'audio');
        await vi.advanceTimersByTimeAsync(0);

        rtc.tearDownPeer('u1');
        expect(rtc.subscribeDiagnostics().peers, 'a retracted order must not stay outstanding').toEqual([]);

        // Same session id: they never republished, they only left the 3x3 block and returned.
        await rtc.subscribeToPeer('u1', 'peer-session-1', 'audio');
        await vi.advanceTimersByTimeAsync(0);

        expect(pulls()).toEqual(['u1@peer-session-1', 'u1@peer-session-1']);
        expect(rtc.peers().has('u1')).toBe(true);
    });
});

describe('the reconcile', () => {
    it('re-drives a peer whose pull was abandoned, on the next publication', async () => {
        await rtc.connect();
        publisher.subscribeError = new Error('the SFU refused the pull');
        const order = rtc.subscribeToPeer('u1', 'peer-session-1', 'audio');
        await vi.advanceTimersByTimeAsync(60_000);
        await order;
        expect(rtc.peers().has('u1')).toBe(false);

        // A republish re-drives the relay, which re-issues the order; the point is that a *fresh*
        // order for the identity we already failed on is not skipped as a duplicate.
        publisher.subscribeError = null;
        await rtc.disconnect();
        await rtc.connect();
        await rtc.subscribeToPeer('u1', 'peer-session-1', 'audio');
        await vi.advanceTimersByTimeAsync(0);

        expect(rtc.peers().has('u1')).toBe(true);
    });

    it('re-drives a peer it gave up on, and re-pulls nothing else', async () => {
        // What the status poll calls. A peer given up on has no other route back, and the peers around
        // them must not be re-pulled to get them - re-pulling a healthy pair can cost a renegotiation,
        // which is exactly why the relay does not re-blast audible pairs itself. (That second half is
        // enforced by the dedupe rather than by the filter in `reconcile`: widening the filter to every
        // peer leaves this green, which is the right answer and worth knowing.)
        await rtc.connect();
        await rtc.subscribeToPeer('healthy', 'peer-session-h', 'audio');
        publisher.subscribeError = new Error('the SFU refused the pull');
        const order = rtc.subscribeToPeer('broken', 'peer-session-b', 'audio');
        await vi.advanceTimersByTimeAsync(60_000);
        await order;

        publisher.subscribeError = null;
        const before = pulls().length;
        await rtc.reconcile();
        await vi.advanceTimersByTimeAsync(0);

        expect(pulls().slice(before)).toEqual(['broken@peer-session-b']);
        expect(rtc.peers().has('broken')).toBe(true);
    });

    it('forgets every order when the publication goes, so nothing is pulled onto the next one', async () => {
        await rtc.connect();
        await rtc.subscribeToPeer('u1', 'peer-session-1', 'audio');
        await vi.advanceTimersByTimeAsync(0);

        await rtc.disconnect();
        const before = pulls().length;
        await rtc.connect();
        await vi.advanceTimersByTimeAsync(0);

        // Orders recorded against a publication that has gone name peer sessions the relay is about to
        // re-issue anyway; replaying them would pull against a track we can no longer be pulled on.
        expect(pulls()).toHaveLength(before);
        expect(rtc.subscribeDiagnostics().peers).toEqual([]);
    });
});
