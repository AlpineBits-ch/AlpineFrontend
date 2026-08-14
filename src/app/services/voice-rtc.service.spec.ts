/**
 * Subscribing to a remote audio track races the publisher's handshake.
 *
 * The backend announces a participant as soon as Cloudflare accepts their `tracks/new` - one SDP
 * answer before they have applied it, finished ICE and DTLS, and sent a packet. Pull the track in
 * that window and Cloudflare answers `not_found_track_error` for a track that is about to exist.
 * These tests pin the recovery: retry across that window, do not retry into a participant who has
 * left, and never subscribe twice for a session already being pulled.
 */
// No `vi.mock('@tauri-apps/api/core')`. Nothing this file's injector graph reaches imports it any
// more - the host branches it used to stand in for went to `ScreenPublisher` and the other ports -
// and the mock was doing real harm while it stayed: several spec files register one and only one
// wins per run, so what any of them saw depended on file ordering.
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {OAuthService} from 'angular-oauth2-oidc';
import {of, Subject, throwError} from 'rxjs';
import {GuildVoiceService} from './guild-voice.service';
import {SUBSCRIBE_RETRY_DELAYS_MS, VoiceRTCService} from './voice-rtc.service';
import {STALE_SUBSCRIPTION} from '../models/voice-room';
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
const SESSION = {slot: 'primary', mediaSessionId: 'rust_sess', trackName: 'audio'};

let engine: FakeEngine;
let service: VoiceRTCService;
/** Stands in for `RustMediaService.publishEnded$` - the publisher saying its share stopped. */
let publishEnded: Subject<void>;

/** The failure Cloudflare returns while the publisher is still connecting. */
const notFound = () => new Error('not_found_track_error');

const target = (userId = 'user_a', mediaSessionId = 'sess_1') => ({
    userId, mediaSessionId, trackName: 'audio',
});

beforeEach(() => {
    vi.useFakeTimers();
    engine = new FakeEngine();
    publishEnded = new Subject<void>();

    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: VoiceEngineService, useValue: engine},
            // Stubbed rather than real: its constructor reads localStorage, which these tests have
            // no use for and jsdom does not provide here.
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://example.test'}},
            {provide: AudioSettingsService, useValue: {settings: () => ({})}},
            // `publishEnded$` is not optional garnish: the service subscribes it at construction,
            // so a bare `{}` here is a stub that could not stand the real service up.
            {provide: RustMediaService, useValue: {publishEnded$: publishEnded}},
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

/**
 * The backend backfills the room from inside its `cf/tracks/new` handler, awaiting the SignalR
 * sends *before* returning the HTTP 200 that the Rust `voice_start` is still waiting on. So an
 * announcement for someone already in the channel always arrives before `voiceSession` is set - and
 * `VoiceStateResponse` deliberately carries no `mediaSessionId`, so that announcement is the only one
 * there will ever be. Dropping it made everyone already present permanently inaudible.
 */
it('waits for the session rather than dropping an announcement that beat it', async () => {
    (service as unknown as {voiceSession: unknown}).voiceSession = null;

    const done = service.subscribeAudio([target()]);
    // The session lands while the first backoff is still sleeping, exactly as it does when the
    // `voice_start` invoke finally resolves.
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_DELAYS_MS[0]);
    (service as unknown as {voiceSession: typeof SESSION}).voiceSession = SESSION;
    await drainRetries();
    await done;

    expect(engine.subscribe).toHaveBeenCalledWith(SESSION, 'user_a', 'sess_1', 'audio');
});

it('gives up on an announcement when no session ever arrives', async () => {
    (service as unknown as {voiceSession: unknown}).voiceSession = null;

    const done = service.subscribeAudio([target()]);
    await drainRetries();
    await done;

    expect(engine.subscribe).not.toHaveBeenCalled();
});

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

/**
 * The interleaving behind the incident logs, where a caller heard a peer for a second or two and
 * then never again on a connection that reported itself perfectly healthy.
 *
 * Three paths announce the same publisher and none of them is awaited: the join snapshot, the
 * refetch after connect, and the live ParticipantJoined. A subscription is only *recorded* once it
 * succeeds, so a duplicate arriving while the first is in flight saw no record, claimed a newer
 * token, and called the engine again - which returns Ok for a source it already holds without
 * pulling anything. The first attempt then found its token superseded and unsubscribed, taking the
 * engine's mid route with it, while the duplicate recorded a subscription that did not exist.
 *
 * The SFU carried on sending: `tracks 1`, `routed +0`, `unmapped +N`, `subscribed []`. And because
 * the phantom record made every later announcement a duplicate, it never repaired.
 */
it('does not tear down a subscription when one participant is announced twice at once', async () => {
    let settle: () => void = () => {
    };
    engine.subscribe.mockImplementationOnce(() => new Promise<void>(r => {
        settle = r;
    }));

    const first = service.subscribeAudio([target()]);
    await vi.advanceTimersByTimeAsync(0);
    // Identical announcement, arriving while the first is still in flight.
    const second = service.subscribeAudio([target()]);
    settle();
    await Promise.all([first, second]);

    expect(engine.subscribe).toHaveBeenCalledTimes(1);
    expect(engine.unsubscribe).not.toHaveBeenCalled();
    expect(service.participantsWithAudio()).toContain('user_a');
});

/**
 * The same overlap, but where the second announcement is a genuine correction. Both must still
 * happen, and in an order that leaves the engine holding the *new* session - the unsubscribe of the
 * old one must land before the new one is pulled, never after it.
 */
it('orders a corrected announcement behind the one it supersedes', async () => {
    let settle: () => void = () => {
    };
    engine.subscribe.mockImplementationOnce(() => new Promise<void>(r => {
        settle = r;
    }));

    const first = service.subscribeAudio([target('user_a', 'sess_1')]);
    await vi.advanceTimersByTimeAsync(0);
    const second = service.subscribeAudio([target('user_a', 'sess_2')]);
    settle();
    await Promise.all([first, second]);

    expect(engine.subscribe).toHaveBeenNthCalledWith(2, SESSION, 'user_a', 'sess_2', 'audio');
    // An unsubscribe that ran after the replacement was pulled would drop the replacement's route
    // and leave the source unreachable - which is the failure, not the recovery.
    expect(engine.unsubscribe.mock.invocationCallOrder[0])
        .toBeLessThan(engine.subscribe.mock.invocationCallOrder[1]);
});

it('resubscribes when the same participant is announced on a new session', async () => {
    await service.subscribeAudio([target('user_a', 'sess_1')]);
    await service.subscribeAudio([target('user_a', 'sess_2')]);

    // The old session is no longer publishing - dropping it is what stops a dead source being
    // mixed in and a dead m-line being carried by every later renegotiation.
    expect(engine.unsubscribe).toHaveBeenCalledWith(SESSION, 'user_a');
    expect(engine.subscribe).toHaveBeenNthCalledWith(2, SESSION, 'user_a', 'sess_2', 'audio');
});

/**
 * When the connection that receives video is opened.
 *
 * It used to be opened during `connect`, and that is why a screen share never rendered for a viewer
 * who had been sitting in the channel. Nothing negotiates that connection until a camera or a share
 * actually appears - audio is the Rust engine's now, so a listener never sends an offer at all - and
 * the SFU drops any session whose peer connection never connects. By the time somebody shared, the
 * session created at join was already gone, `tracks/new` answered 502 `session_error` forever, and
 * the viewer sat on the "sharing" placeholder.
 */
describe('the receive session', () => {
    /** jsdom has no WebRTC; only construction and the ontrack hook are reached here. */
    class StubPeerConnection {
        ontrack: unknown = null;
        onconnectionstatechange: unknown = null;
        connectionState = 'new';
        localDescription = {type: 'offer', sdp: ''};

        addTransceiver = vi.fn(() => ({setCodecPreferences: vi.fn()}));
        createOffer = vi.fn(async () => ({type: 'offer', sdp: ''}));
        setLocalDescription = vi.fn(async () => {
        });
        setRemoteDescription = vi.fn(async () => {
        });
        close = vi.fn();
    }

    let createSession: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        const globals = globalThis as unknown as Record<string, unknown>;
        globals['RTCPeerConnection'] = StubPeerConnection;
        // Codec preference ordering reads these; jsdom has neither.
        globals['RTCRtpReceiver'] = {getCapabilities: () => ({codecs: []})};
        globals['RTCRtpSender'] = {getCapabilities: () => ({codecs: []})};
        const guildVoice = TestBed.inject(GuildVoiceService);
        createSession = vi.spyOn(guildVoice, 'createSession')
            .mockReturnValue(of({mediaSessionId: 'recv_sess', backend: 'cloudflare'}));
        vi.spyOn(guildVoice, 'negotiateTracks').mockReturnValue(of({
            sessionDescription: {type: 'answer', sdp: ''},
            tracks: [{mid: '0', trackName: 'screen-abc'}],
            requiresImmediateRenegotiation: false,
        }));
    });

    it('is not opened until something needs it', async () => {
        // Joining a channel and listening is the common case, and it must cost no session at all.
        await service.subscribeAudio([target()]);

        expect(createSession).not.toHaveBeenCalled();
    });

    it('is opened by the subscribe that first needs it', async () => {
        await service.subscribeVideo('g1', 'c1', 'user_a', 'sess_1', 'screen-abc', 'screen');

        // Created and negotiated inside the same operation, which is the point: an SFU session with
        // no peer connection behind it does not survive being left for later.
        expect(createSession).toHaveBeenCalledWith('g1', 'c1', false);
    });

    it('stops re-pulling a share the SFU has already refused as stale', async () => {
        // The other half of the console the field report came with: `screen-<id>` and
        // `screen-audio-<id>` looping side by side, so both paths need the guard.
        const guildVoice = TestBed.inject(GuildVoiceService);
        let calls = 0;
        vi.spyOn(guildVoice, 'negotiateTracks').mockImplementation(() => {
            calls++;
            return throwError(() => ({status: 409, error: {error: STALE_SUBSCRIPTION}}));
        });

        await service.subscribeVideo('g1', 'c1', 'user_a', 'sess_1', 'screen-abc', 'screen');
        await service.subscribeVideo('g1', 'c1', 'user_a', 'sess_1', 'screen-abc', 'screen');
        await service.subscribeVideo('g1', 'c1', 'user_a', 'sess_1', 'screen-abc', 'screen');

        expect(calls).toBe(1);
    });

    it('is opened once however many tracks are announced together', async () => {
        // A share with audio, or a snapshot backfill covering several publishers, announces more
        // than one track at the same moment.
        await Promise.all([
            service.subscribeVideo('g1', 'c1', 'user_a', 'sess_1', 'screen-abc', 'screen'),
            service.subscribeVideo('g1', 'c1', 'user_b', 'sess_2', 'video', 'video'),
        ]);

        expect(createSession).toHaveBeenCalledTimes(1);
    });
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

/**
 * `staleSubscription` says that track on that session has stopped, so the identical request can
 * never succeed. The answer is to refetch the snapshot and pull whatever replaced it - but the
 * refetch re-announces whatever the server still lists, and while the server's record and
 * Cloudflare's disagree that is the dead track again.
 *
 * Nothing on that path sleeps, so it spins as fast as the network allows. The field report is a
 * viewer's console filling with `subscribe refused as stale` alternating with 409s, for both halves
 * of a screen share at once, for as long as they stayed in the channel.
 */
describe('a publication refused as stale', () => {
    /** What the backend answers once Cloudflare no longer has the track. */
    const stale = () => ({status: 409, error: {error: STALE_SUBSCRIPTION}});

    let refetches: number;

    beforeEach(() => {
        refetches = 0;
        service.staleSubscription$.subscribe(() => refetches++);
    });

    it('asks for a refetch, because only a snapshot can find the replacement', async () => {
        engine.subscribe.mockRejectedValue(stale());

        await service.subscribeAudio([target()]);

        expect(refetches).toBe(1);
    });

    it('is not retried when the refetch announces the same publication again', async () => {
        engine.subscribe.mockRejectedValue(stale());

        // Three rounds of exactly what the reconcile after a refetch does.
        await service.subscribeAudio([target()]);
        await service.subscribeAudio([target()]);
        await service.subscribeAudio([target()]);

        // One attempt, not three. Without this the request and the refetch it triggers feed each
        // other for the rest of the call.
        expect(engine.subscribe).toHaveBeenCalledTimes(1);
        expect(refetches).toBe(1);
    });

    it('is retried once the publisher comes back on a new session', async () => {
        engine.subscribe.mockRejectedValueOnce(stale()).mockResolvedValue(undefined);

        await service.subscribeAudio([target('user_a', 'sess_dead')]);
        await service.subscribeAudio([target('user_a', 'sess_new')]);

        // Keyed on the session, so a republish is unaffected - which is the whole point of
        // refetching in the first place.
        expect(engine.subscribe).toHaveBeenCalledTimes(2);
        expect(service.participantsWithAudio()).toContain('user_a');
    });

    it('is forgotten when the participant leaves', async () => {
        engine.subscribe.mockRejectedValueOnce(stale()).mockResolvedValue(undefined);

        await service.subscribeAudio([target('user_a', 'sess_1')]);
        service.cleanupParticipant('user_a');
        await service.subscribeAudio([target('user_a', 'sess_1')]);

        expect(engine.subscribe).toHaveBeenCalledTimes(2);
    });

    it('does not block a different participant on the same session id', async () => {
        engine.subscribe.mockImplementation(async (_s: unknown, id: string) => {
            if (id === 'user_a') throw stale();
        });

        await service.subscribeAudio([target('user_a'), target('user_b')]);

        expect(service.participantsWithAudio()).toContain('user_b');
    });
});

/**
 * Rebuilding the publish at a new resolution is the only path that stops one share in order to
 * start another. The old share is dead the moment the stop returns, and the room learns that only
 * from what this hands back - so a rebuild that fails must still report the stop. Swallowing it
 * left the share on the server's roster with no session behind it, which is the state every viewer
 * then loops against.
 */
describe('rebuilding a share at a new resolution', () => {
    const preset = {resolution: '1440p', framerate: 30} as const;

    function sharing(): {startScreenPublish: ReturnType<typeof vi.fn>} {
        const rustMedia = TestBed.inject(RustMediaService) as unknown as Record<string, unknown>;
        rustMedia['stopScreenPublish'] = vi.fn(async () => undefined);
        rustMedia['startScreenPublish'] = vi.fn();
        // `publishOptions` reads this; the shared stub only carries the method other tests need.
        (TestBed.inject(DeviceIdentityService) as unknown as Record<string, unknown>)['deviceId'] =
            vi.fn(async () => 'device');

        // The state a running Rust publish leaves behind, reached into directly rather than stood
        // up through a real publish and its signalling.
        Object.assign(service as unknown as Record<string, unknown>, {
            rustPublishing: true,
            screenShareId: 'old-share',
            rustChoice: {sourceId: 'monitor:0', sourceWidth: 1920, sourceHeight: 1080, preset: {resolution: '1080p', framerate: 30}, shareAudio: false},
        });
        service.screenPreset.set({resolution: '1080p', framerate: 30});
        return {startScreenPublish: rustMedia['startScreenPublish'] as ReturnType<typeof vi.fn>};
    }

    it('reports the swap when the new publish comes up', async () => {
        const {startScreenPublish} = sharing();
        startScreenPublish.mockResolvedValue({encoder: 'media-foundation', audioTrackName: null});

        const restart = await service.setScreenPreset(preset, 'g1', 'c1');

        expect(restart?.oldShareId).toBe('old-share');
        expect(restart?.newShareId).toBeTruthy();
    });

    it('still reports the stop when the new publish fails', async () => {
        // Not exotic: the rebuild constructs an encoder at a resolution the hardware may refuse,
        // which is exactly the case this path exists for.
        const {startScreenPublish} = sharing();
        startScreenPublish.mockRejectedValue(new Error('no H.264 encoder available'));

        const restart = await service.setScreenPreset(preset, 'g1', 'c1');

        expect(restart).not.toBeNull();
        expect(restart?.oldShareId).toBe('old-share');
        expect(restart?.newShareId).toBeNull();
    });
});

/**
 * In a browser the share does not end because the app asked. It ends because the user pressed the
 * browser's own "Stop sharing" bar, and the first this side hears of it is the publisher saying so
 * afterwards. Nothing on this peer connection can see it - a publisher-owned share puts no track in
 * the webview, so there is no `onended` to hang it on - which is why it has to be forwarded.
 */
describe('a share the publisher ended by itself', () => {
    /** The single consumer of `screenEnded$` is `VoiceChannelService`, which stops the share. */
    function watchScreenEnded(): ReturnType<typeof vi.fn> {
        const spy = vi.fn();
        service.screenEnded$.subscribe(spy);
        return spy;
    }

    it('unlights the button when the browser tore down our own publish', () => {
        (service as unknown as Record<string, unknown>)['rustPublishing'] = true;
        const spy = watchScreenEnded();

        publishEnded.next();

        expect(spy).toHaveBeenCalledTimes(1);
    });

    /**
     * `RustMediaService` is a singleton shared with the 1:1 call path, so this fires for whichever
     * publish ended. Without the guard, a call's share stopping would announce that this channel's
     * share had stopped - to a service that never started one.
     */
    it('ignores a publish this service never started', () => {
        (service as unknown as Record<string, unknown>)['rustPublishing'] = false;
        const spy = watchScreenEnded();

        publishEnded.next();

        expect(spy).not.toHaveBeenCalled();
    });
});

/**
 * The guild-side twin of `CallWebRtcService`'s inbound fps test: `pollStats` reads
 * `CallScreenShare.inboundFps` off `getStats()`, routed through the mid → {userId, kind} map
 * `subscribeVideo` writes. Reached into as private state rather than driven through a full
 * subscribe, for the same reason as the DM side - the stub `RTCPeerConnection` above hands out a
 * fixed mid, which cannot stand up two shares side by side.
 */
describe('inbound screen-share fps', () => {
    function internals(s: VoiceRTCService) {
        return s as unknown as {
            pc: {getStats(): Promise<Map<string, unknown>>} | null;
            midMeta: Map<string, {userId: string; kind: 'video' | 'screen'}>;
            pollStats(): Promise<void>;
        };
    }

    function inboundRtpVideo(mid: string, framesPerSecond?: number) {
        return {type: 'inbound-rtp', kind: 'video', mid, framesPerSecond};
    }

    it('reports a remote share fps keyed by user id once a stat carries one', async () => {
        const internal = internals(service);
        internal.midMeta.set('m1', {userId: 'user_a', kind: 'screen'});
        internal.pc = {getStats: async () => new Map([['s1', inboundRtpVideo('m1', 24)]])};

        await internal.pollStats();

        expect(service.inboundVideoFps()).toEqual({user_a: 24});
    });

    it('gives two concurrent remote shares two independent fps numbers', async () => {
        const internal = internals(service);
        internal.midMeta.set('m1', {userId: 'user_a', kind: 'screen'});
        internal.midMeta.set('m2', {userId: 'user_b', kind: 'screen'});
        internal.pc = {
            getStats: async () => new Map([
                ['s1', inboundRtpVideo('m1', 30)],
                ['s2', inboundRtpVideo('m2', 12)],
            ]),
        };

        await internal.pollStats();

        expect(service.inboundVideoFps()).toEqual({user_a: 30, user_b: 12});
    });

    it('leaves a share out rather than reporting 0 while its stat has not arrived yet', async () => {
        const internal = internals(service);
        internal.midMeta.set('m1', {userId: 'user_a', kind: 'screen'});
        internal.pc = {getStats: async () => new Map([['s1', inboundRtpVideo('m1', undefined)]])};

        await internal.pollStats();

        expect(service.inboundVideoFps()).toEqual({});
    });

    it('ignores a camera track riding the same connection - this is a screen-share readout only', async () => {
        const internal = internals(service);
        internal.midMeta.set('m1', {userId: 'user_a', kind: 'video'});
        internal.pc = {getStats: async () => new Map([['s1', inboundRtpVideo('m1', 30)]])};

        await internal.pollStats();

        expect(service.inboundVideoFps()).toEqual({});
    });
});


/**
 * A stream's volume is its own gain, independent of its owner's voice - the gap task 6 closes.
 * `setUserVolume`/`getUserVolume` already had this shape for voice; these pin the mirrored
 * `setScreenVolume`/`getScreenVolume` pair, and - the requirement most likely to get missed - that
 * muting a stream never destroys the level stored for it.
 */
describe('stream volume', () => {
    const screenTarget = (userId = 'user_a', mediaSessionId = 'sess_1', trackName = 'screen-audio-abc') => ({
        userId, mediaSessionId, trackName, kind: 'screenAudio' as const,
    });

    it('defaults to full volume for a stream nothing has touched', () => {
        expect(service.getScreenVolume('user_a')).toBe(1);
    });

    it('remembers a level set before the share is even subscribed', async () => {
        service.setScreenVolume('user_a', 0.4);
        expect(service.getScreenVolume('user_a')).toBe(0.4);

        await service.subscribeAudio([screenTarget()]);

        // Applied to the share's mixer source (the track name), not the participant's voice.
        expect(engine.setUserVolume).toHaveBeenCalledWith('screen-audio-abc', 0.4);
        expect(engine.setUserVolume).not.toHaveBeenCalledWith('user_a', 0.4);
    });

    it('applies a volume change live once the share is already subscribed', async () => {
        await service.subscribeAudio([screenTarget()]);
        engine.setUserVolume.mockClear();

        service.setScreenVolume('user_a', 0.25);

        expect(engine.setUserVolume).toHaveBeenCalledWith('screen-audio-abc', 0.25);
    });

    it('clamps out-of-range input the same way setUserVolume does', () => {
        service.setScreenVolume('user_a', 4);
        expect(service.getScreenVolume('user_a')).toBe(1);

        service.setScreenVolume('user_a', -1);
        expect(service.getScreenVolume('user_a')).toBe(0);
    });

    /**
     * Mute and volume are independent controls. Muting must not zero the stored level, and
     * unmuting must bring back exactly what was set - not unity, which is what a naive
     * "mute = set gain to 0, unmute = set gain to 1" implementation would do, and the bug would
     * only show up on the *second* unmute.
     */
    it('round-trips the stored volume through a mute and an unmute', async () => {
        await service.subscribeAudio([screenTarget()]);
        service.setScreenVolume('user_a', 0.6);
        engine.setUserVolume.mockClear();

        service.toggleScreenAudioMute('user_a');
        expect(engine.setUserVolume).toHaveBeenCalledWith('screen-audio-abc', 0);
        // The stored preference survives the mute - it is the mute overlay that changed, not it.
        expect(service.getScreenVolume('user_a')).toBe(0.6);

        service.toggleScreenAudioMute('user_a');
        expect(engine.setUserVolume).toHaveBeenLastCalledWith('screen-audio-abc', 0.6);
        expect(service.getScreenVolume('user_a')).toBe(0.6);
    });

    it('does not apply a volume change made while the stream is muted, but remembers it for unmute', async () => {
        await service.subscribeAudio([screenTarget()]);
        service.toggleScreenAudioMute('user_a'); // mute
        engine.setUserVolume.mockClear();

        service.setScreenVolume('user_a', 0.7);
        expect(engine.setUserVolume).not.toHaveBeenCalled();

        service.toggleScreenAudioMute('user_a'); // unmute
        expect(engine.setUserVolume).toHaveBeenCalledWith('screen-audio-abc', 0.7);
    });

    it('never lets the stream volume path touch the participant voice source', async () => {
        await service.subscribeAudio([screenTarget()]);
        service.setScreenVolume('user_a', 0.5);
        service.toggleScreenAudioMute('user_a');
        service.toggleScreenAudioMute('user_a');

        expect(engine.setUserVolume).not.toHaveBeenCalledWith('user_a', expect.anything());
    });
});
