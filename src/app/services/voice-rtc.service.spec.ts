/**
 * Subscribing to a remote audio track races the publisher's handshake.
 *
 * The backend announces a participant as soon as Cloudflare accepts their `tracks/new` - one SDP
 * answer before they have applied it, finished ICE and DTLS, and sent a packet. Pull the track in
 * that window and Cloudflare answers `not_found_track_error` for a track that is about to exist.
 * These tests pin the recovery: retry across that window, do not retry into a participant who has
 * left, and never subscribe twice for a session already being pulled.
 */
// A spy rather than a fixed arrow, and set below per test: several spec files mock this module and
// only one registration wins per run, so anything relying on this file's value held or not
// depending on file ordering. See the same note in voice-engine.service.spec.ts.
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn().mockResolvedValue(undefined),
    isTauri: vi.fn(() => false),
    Channel: class {
    },
}));

import {TestBed} from '@angular/core/testing';
import {isTauri} from '@tauri-apps/api/core';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {OAuthService} from 'angular-oauth2-oidc';
import {SUBSCRIBE_RETRY_DELAYS_MS, VoiceRTCService} from './voice-rtc.service';
import {VoiceEngineService} from './voice-engine.service';
import {RustMediaService} from './rust-media.service';
import {ScreenPickerService} from './screen-picker.service';
import {DeviceIdentityService} from './device-identity.service';
import {ApiConfigService} from './api-config.service';
import {AudioSettingsService} from './audio-settings.service';

/** Stands in for the Rust engine. Only the calls these tests exercise are implemented. */
class FakeEngine {
    subscribe = vi.fn().mockResolvedValue(undefined);
    unsubscribe = vi.fn().mockResolvedValue(undefined);
    setUserVolume = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    available = () => false;
}

/**
 * The publication this channel's audio runs on.
 *
 * Every engine call now names one, because Isle proximity voice can be running on the same
 * microphone. `slot` is Rust's, and opaque to the frontend.
 */
const SESSION = {slot: 'primary', cfSessionId: 'rust_sess', trackName: 'audio'};

let engine: FakeEngine;
let service: VoiceRTCService;

/** The failure Cloudflare returns while the publisher is still connecting. */
const notFound = () => new Error('not_found_track_error');

const target = (userId = 'user_a', cfSessionId = 'sess_1') => ({
    userId, cfSessionId, trackName: 'audio',
});

beforeEach(() => {
    vi.useFakeTimers();
    // The engine is faked here, so nothing should be reaching Rust directly.
    vi.mocked(isTauri).mockReturnValue(false);
    engine = new FakeEngine();

    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: VoiceEngineService, useValue: engine},
            // Stubbed rather than real: its constructor reads localStorage, which these tests have
            // no use for and jsdom does not provide here.
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://example.test'}},
            {provide: AudioSettingsService, useValue: {settings: () => ({})}},
            {provide: RustMediaService, useValue: {}},
            {provide: ScreenPickerService, useValue: {}},
            {provide: DeviceIdentityService, useValue: {get: vi.fn().mockResolvedValue('device')}},
            {provide: OAuthService, useValue: {getAccessToken: () => 'token'}},
        ],
    });
    service = TestBed.inject(VoiceRTCService);
    // Stand the service up as though `setup` had connected, without the RTCPeerConnection and the
    // signalling round trips it also does - none of which these tests are about. Reached into
    // directly rather than through a setter that would exist only for this.
    (service as unknown as {voiceSession: typeof SESSION}).voiceSession = SESSION;
});

afterEach(() => {
    vi.useRealTimers();
});

/** Let every pending backoff elapse, however many rounds of promise plumbing that takes. */
async function drainRetries(): Promise<void> {
    for (let i = 0; i <= SUBSCRIBE_RETRY_DELAYS_MS.length; i++) {
        await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_DELAYS_MS[i] ?? 0);
    }
}

it('retries a subscribe that fails while the publisher is still connecting', async () => {
    // Fails twice, as it does when the peer's DTLS handshake outlasts the backend's own retries,
    // then succeeds once they are sending.
    engine.subscribe
        .mockRejectedValueOnce(notFound())
        .mockRejectedValueOnce(notFound())
        .mockResolvedValueOnce(undefined);

    const done = service.subscribeAudio([target()]);
    await drainRetries();
    await done;

    expect(engine.subscribe).toHaveBeenCalledTimes(3);
    expect(service.participantsWithAudio()).toContain('user_a');
});

it('gives up after the last backoff rather than retrying forever', async () => {
    engine.subscribe.mockRejectedValue(notFound());

    const done = service.subscribeAudio([target()]);
    await drainRetries();
    await done;

    // One initial attempt plus one per delay. A participant who never publishes must not leave a
    // timer running for the rest of the session.
    expect(engine.subscribe).toHaveBeenCalledTimes(SUBSCRIBE_RETRY_DELAYS_MS.length + 1);
    expect(service.participantsWithAudio()).not.toContain('user_a');
});

it('stops retrying when the participant leaves mid-backoff', async () => {
    engine.subscribe.mockRejectedValue(notFound());

    const done = service.subscribeAudio([target()]);
    // Let the first attempt fail and the first backoff start.
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.subscribe).toHaveBeenCalledTimes(1);

    service.cleanupParticipant('user_a');
    await drainRetries();
    await done;

    // Still one. Resubscribing someone who has left puts a source in the mixer that nothing will
    // ever remove, because the event that would have removed it has already been handled.
    expect(engine.subscribe).toHaveBeenCalledTimes(1);
});

it('drops a subscription that completed after the participant left', async () => {
    // The failure the token guard exists for: the call is in flight, not sleeping, when they go.
    let settle: () => void = () => {
    };
    engine.subscribe.mockImplementationOnce(() => new Promise<void>(r => {
        settle = r;
    }));

    const done = service.subscribeAudio([target()]);
    await vi.advanceTimersByTimeAsync(0);

    service.cleanupParticipant('user_a');
    settle();
    await done;

    expect(engine.unsubscribe).toHaveBeenCalledWith(SESSION, 'user_a');
    expect(service.participantsWithAudio()).not.toContain('user_a');
});

it('ignores a repeated announcement for a session it is already pulling', async () => {
    await service.subscribeAudio([target()]);
    await service.subscribeAudio([target()]);

    // The backfill announces everyone already present, so this repeat is routine. Acting on it
    // would add a second recvonly transceiver in Rust for a track already being pulled.
    expect(engine.subscribe).toHaveBeenCalledTimes(1);
});

it('resubscribes when the same participant is announced on a new session', async () => {
    await service.subscribeAudio([target('user_a', 'sess_1')]);
    await service.subscribeAudio([target('user_a', 'sess_2')]);

    // The old session is no longer publishing - dropping it is what stops a dead source being
    // mixed in and a dead m-line being carried by every later renegotiation.
    expect(engine.unsubscribe).toHaveBeenCalledWith(SESSION, 'user_a');
    expect(engine.subscribe).toHaveBeenNthCalledWith(2, SESSION, 'user_a', 'sess_2', 'audio');
});

it('does not let one slow participant hold up the others announced with them', async () => {
    // Joining a busy channel backfills the whole room at once. If these ran in sequence, the first
    // participant still connecting would delay everyone behind them by the full retry budget.
    engine.subscribe.mockImplementation(async (_session: unknown, id: string) => {
        if (id === 'user_a') throw notFound();
    });

    const done = service.subscribeAudio([target('user_a'), target('user_b')]);
    await vi.advanceTimersByTimeAsync(0);

    expect(service.participantsWithAudio()).toContain('user_b');

    await drainRetries();
    await done;
});
