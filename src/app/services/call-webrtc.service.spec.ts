/**
 * The subscribe path of a DM call.
 *
 * Bug this covers: `subscribeToTrack` returned silently when the Rust publication did not exist
 * yet, and every announcement triggered by session creation arrives while `voiceEngine.start()` is
 * still pending - so the participant stayed inaudible for the whole call, with nothing to retry it.
 * The guild path has waited for its session since the Rust engine landed; this is the port.
 */
import type {MockInstance} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {Observable, of, Subject, throwError} from 'rxjs';
import {HttpErrorResponse} from '@angular/common/http';
import {signal} from '@angular/core';
import {CallWebRtcService} from './call-webrtc.service';
import {CallSessionService} from './call-session.service';
import {VoiceService} from './voice.service';
import {VoiceWebsocketService} from './voice-websocket.service';
import {AudioSettingsService} from './audio-settings.service';
import {RustMediaService} from './rust-media.service';
import {ScreenPickerService} from './screen-picker.service';
import {VoiceEngineService, VoiceSession} from './voice-engine.service';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';
import {ToastService} from './toast.service';
import {TranslateService} from '@ngx-translate/core';
import {OAuthService} from 'angular-oauth2-oidc';
import {SUBSCRIBE_RETRY_DELAYS_MS} from './voice-rtc.service';

/** Long enough for `awaitSession` to exhaust its schedule. */
const PAST_ALL_RETRIES = SUBSCRIBE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 200;

/**
 * Enough `RTCPeerConnection` for `connect()` to run to completion.
 *
 * jsdom has no WebRTC at all, and without this the connect effect throws before reaching
 * `voiceEngine.start()` - which is precisely the window these tests are about. Audio does not touch
 * this connection anyway: it is pulled onto the Rust session and mixed there.
 */
class StubPeerConnection {
    connectionState = 'new';
    ontrack: unknown = null;
    onconnectionstatechange: unknown = null;

    addTransceiver() {
        return {mid: '0', sender: {}, setCodecPreferences: () => undefined};
    }

    getTransceivers() {
        return [];
    }

    getSenders() {
        return [];
    }

    async createOffer() {
        return {type: 'offer', sdp: 'v=0'};
    }

    async setLocalDescription() {
        return undefined;
    }

    async setRemoteDescription() {
        return undefined;
    }

    async getStats() {
        return new Map();
    }

    close() {
        return undefined;
    }
}

beforeEach(() => {
    (globalThis as unknown as {RTCPeerConnection: unknown}).RTCPeerConnection = StubPeerConnection;
});

function setup(options: {cfCreateSession?: () => Observable<unknown>} = {}) {
    // Every observable the service subscribes to at connect. An incomplete set throws before any
    // test body runs.
    const ws: Record<string, Subject<unknown>> = {};
    for (const name of [
        'participantJoinedObservable', 'trackPublishedObservable', 'trackClosedObservable',
        'muteChangedObservable', 'speakingChangedObservable', 'cameraChangedObservable',
        'screenShareStartedObservable', 'screenShareStoppedObservable',
        'callParticipantLeftObservable', 'callAloneObservable', 'callEndedObservable',
        'voiceSnapshotObservable', 'voiceResyncObservable',
    ]) ws[name] = new Subject();

    const session = signal<{
        callId: string;
        participants: {userId: string; isLocal: boolean}[];
        local: {isMuted: boolean; isDeafened: boolean; isCameraOn: boolean; isSharing: boolean};
        screenShares: unknown[];
    } | null>({
        callId: 'call-1',
        participants: [{userId: 'me', isLocal: true}],
        local: {isMuted: false, isDeafened: false, isCameraOn: false, isSharing: false},
        screenShares: [],
    });

    const engineSubscribe = vi.fn(async () => undefined);
    const engineVolume = vi.fn(async () => undefined);
    const getCallSnapshot = vi.fn(() => of({
        roomId: 'call-1', kind: 'call', guildId: null,
        instanceId: 'inst-1', version: 1, participants: [],
    }));
    // Never resolves on its own - the test decides when the publication exists, which is the whole
    // window this covers.
    let resolveStart: (s: VoiceSession) => void = () => undefined;
    const started = new Promise<VoiceSession>(r => {
        resolveStart = r;
    });

    TestBed.configureTestingModule({
        providers: [
            {
                provide: CallSessionService,
                useValue: {
                    session,
                    screenPreset: () => null,
                    pttGateOpen: () => true,
                    onParticipantJoined: vi.fn(),
                    onParticipantLeft: vi.fn(),
                    onSpeakingChanged: vi.fn(),
                    onMuteChanged: vi.fn(),
                    onCameraChanged: vi.fn(),
                    onScreenShareStarted: vi.fn(),
                    onScreenShareStopped: vi.fn(),
                    setAloneDeadline: vi.fn(),
                    end: vi.fn(),
                },
            },
            {
                provide: VoiceService,
                useValue: {
                    cfCreateSession: vi.fn(options.cfCreateSession
                        ?? (() => of({mediaSessionId: 'cf-web', backend: 'cloudflare'}))),
                    getCall: vi.fn(() => of({status: 'Connected', participants: [{userId: 'me'}]})),
                    getCallSnapshot,
                },
            },
            {provide: VoiceWebsocketService, useValue: {...ws, connectionState: () => 2, invokeVoiceHeartbeat: vi.fn(), invokeMuteChange: vi.fn(), invokeScreenShareStarted: vi.fn(), invokeScreenShareStopped: vi.fn()}},
            {provide: AudioSettingsService, useValue: {buildVideoConstraint: vi.fn(async () => true)}},
            {provide: RustMediaService, useValue: {stopScreenCapture: vi.fn(), stopScreenPublish: vi.fn()}},
            {provide: ScreenPickerService, useValue: {show: vi.fn()}},
            {
                provide: VoiceEngineService,
                useValue: {
                    start: vi.fn(() => started),
                    stop: vi.fn(),
                    subscribe: engineSubscribe,
                    unsubscribe: vi.fn(async () => undefined),
                    setMute: vi.fn(async () => undefined),
                    setDeafened: vi.fn(async () => undefined),
                    setPttOpen: vi.fn(),
                    setUserVolume: engineVolume,
                    speaking: () => false,
                    remoteLevels: () => new Map(),
                },
            },
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test'}},
            {provide: DeviceIdentityService, useValue: {deviceId: vi.fn(async () => 'dev-1')}},
            {provide: ToastService, useValue: {info: vi.fn(), error: vi.fn(), httpError: vi.fn()}},
            {provide: OAuthService, useValue: {getAccessToken: () => 'tok'}},
            // Echoes the key rather than loading real translations, so an assertion names the key
            // the service chose instead of a sentence that could be reworded.
            {provide: TranslateService, useValue: {instant: (key: string) => key}},
        ],
    });

    const service = TestBed.inject(CallWebRtcService);
    return {service, ws, engineSubscribe, engineVolume, getCallSnapshot, resolveStart: (s: VoiceSession) => resolveStart(s)};
}

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms));

/** Reaches the private subscribe directly: the announcement paths that call it are already covered. */
function subscribeAudio(service: CallWebRtcService, userId: string): Promise<void> {
    return (service as unknown as {
        subscribeToTrack(u: string, s: string, t: string, k: 'audio'): Promise<void>;
    }).subscribeToTrack(userId, 'cf-theirs', 'audio', 'audio');
}

describe('subscribing before the publication exists', () => {
    /**
     * The window this is all about: the announcement arrives, the Rust session is still starting.
     * The old code returned here and the participant was never heard again.
     */
    it('waits for the session rather than dropping the subscribe', async () => {
        const {service, engineSubscribe, resolveStart} = setup();
        const pending = subscribeAudio(service, 'them');

        await tick();
        expect(engineSubscribe).not.toHaveBeenCalled();

        resolveStart({slot: 'slot-1', mediaSessionId: 'cf-rust', trackName: 'audio'} as VoiceSession);
        await pending;

        expect(engineSubscribe).toHaveBeenCalledWith(
            expect.objectContaining({slot: 'slot-1'}), 'them', 'cf-theirs', 'audio');
    });

    /**
     * The guard is claimed before the wait, so a second announcement in the same window does not
     * subscribe twice - and released if the session never arrives, so a later announcement or the
     * next snapshot still can. Leaving it consumed is what made one bad moment permanent.
     */
    it('releases the dedupe guard when the session never arrives', async () => {
        const {service, engineSubscribe, resolveStart} = setup();

        await subscribeAudio(service, 'them');
        expect(engineSubscribe).not.toHaveBeenCalled();

        // The publication turns up late; the retry must not be skipped as a duplicate.
        resolveStart({slot: 'slot-1', mediaSessionId: 'cf-rust', trackName: 'audio'} as VoiceSession);
        await subscribeAudio(service, 'them');

        expect(engineSubscribe).toHaveBeenCalledTimes(1);
    }, PAST_ALL_RETRIES + 5_000);

    /** Once it has actually worked, a repeat announcement is a duplicate and must not resubscribe. */
    it('does not subscribe twice for the same participant', async () => {
        const {service, engineSubscribe, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: 'cf-rust', trackName: 'audio'} as VoiceSession);

        await subscribeAudio(service, 'them');
        await subscribeAudio(service, 'them');

        expect(engineSubscribe).toHaveBeenCalledTimes(1);
    });
});

/**
 * Incident VNT-GE21R3P7: a publisher stopped a share without closing its tracks, the roster kept
 * listing it, and a watcher who did exactly the right thing - read the snapshot, subscribed to what
 * was in `shares[]` - got `not_found_track_error` six seconds later. Retrying the identical body
 * four times a minute put voice on the status page.
 *
 * The server now answers `409 staleSubscription` immediately. The client's job is to treat that as
 * "my view of the room is out of date" rather than as something to retry.
 */
describe('a subscribe the server refuses as stale', () => {
    const stale = {status: 409, error: {error: 'staleSubscription', action: 'refetchSnapshot'}};

    it('refetches the snapshot instead of retrying', async () => {
        const {service, engineSubscribe, getCallSnapshot, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: 'cf-rust', trackName: 'audio'} as VoiceSession);
        // connect() reads the snapshot itself once the transport is up; let that land before
        // clearing, or it is indistinguishable from the refetch under test.
        await tick();
        engineSubscribe.mockRejectedValueOnce(stale);
        getCallSnapshot.mockClear();

        await subscribeAudio(service, 'them');

        expect(getCallSnapshot).toHaveBeenCalled();
        // The track is gone rather than late, so the identical body can only fail again.
        expect(engineSubscribe).toHaveBeenCalledTimes(1);
    });

    /**
     * The guard is consumed on the way in, so leaving it set after a refusal means this participant
     * is never subscribed to again - not when they republish, not on the next snapshot. That is the
     * single most common way a transient failure becomes permanent silence.
     */
    it('releases the dedupe guard, so a republish can be subscribed to', async () => {
        const {service, engineSubscribe, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: 'cf-rust', trackName: 'audio'} as VoiceSession);
        engineSubscribe.mockRejectedValueOnce(stale);

        await subscribeAudio(service, 'them');
        await subscribeAudio(service, 'them');

        expect(engineSubscribe).toHaveBeenCalledTimes(2);
    });

    /** A 502 is a real transport failure, and must not be quietly converted into a refetch. */
    it('does not refetch on a transport failure', async () => {
        const {service, engineSubscribe, getCallSnapshot, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: 'cf-rust', trackName: 'audio'} as VoiceSession);
        await tick();
        engineSubscribe.mockRejectedValueOnce({status: 502, error: {error: 'sfuRejected'}});
        getCallSnapshot.mockClear();

        await subscribeAudio(service, 'them');

        expect(getCallSnapshot).not.toHaveBeenCalled();
    });
});

/**
 * A share's own sound is a second track, and a second *source* - the participant's voice and the
 * audio of the stream they are sharing have to be mutable independently.
 */
describe('screen-share audio', () => {
    function subscribeScreenAudio(service: CallWebRtcService, userId: string, trackName: string) {
        return (service as unknown as {
            subscribeToTrack(u: string, s: string, t: string, k: 'screenAudio'): Promise<void>;
        }).subscribeToTrack(userId, 'cf-theirs', trackName, 'screenAudio');
    }

    /**
     * Keyed by track name, not user id. Sharing the key with the voice source is what would make
     * muting a noisy stream also mute the person sharing it.
     */
    it('pulls the share audio as its own mixer source', async () => {
        const {service, engineSubscribe, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: 'cf-rust', trackName: 'audio'} as VoiceSession);

        await subscribeScreenAudio(service, 'them', 'screen-audio-abc');

        expect(engineSubscribe).toHaveBeenCalledWith(
            expect.objectContaining({slot: 'slot-1'}), 'screen-audio-abc', 'cf-theirs', 'screen-audio-abc');
    });

    it('mutes one participant stream without touching their voice', async () => {
        const {service, engineVolume, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: 'cf-rust', trackName: 'audio'} as VoiceSession);
        await subscribeScreenAudio(service, 'them', 'screen-audio-abc');

        service.toggleScreenAudioMute('them');

        expect(service.isScreenAudioMuted('them')).toBe(true);
        // The stream's source, not the participant's.
        expect(engineVolume).toHaveBeenCalledWith('screen-audio-abc', 0);
        expect(engineVolume).not.toHaveBeenCalledWith('them', 0);

        service.toggleScreenAudioMute('them');
        expect(service.isScreenAudioMuted('them')).toBe(false);
        expect(engineVolume).toHaveBeenCalledWith('screen-audio-abc', 1);
    });

    /**
     * A share that restarts - which a resolution change does, with a fresh share id - must come back
     * muted for anyone who had muted it. The mute is a statement about the person's streams, not
     * about the track that happened to be carrying one.
     */
    it('keeps a stream muted across a restart of the share', async () => {
        const {service, engineVolume, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: 'cf-rust', trackName: 'audio'} as VoiceSession);

        service.toggleScreenAudioMute('them');
        await subscribeScreenAudio(service, 'them', 'screen-audio-second');

        expect(engineVolume).toHaveBeenCalledWith('screen-audio-second', 0);
    });
});

/**
 * `pollStats` reads `CallScreenShare.inboundFps` off the same `getStats()` call that already feeds
 * the connection-quality popover, routed through the mid → {userId, kind, shareId} map subscribing a
 * track writes (see `subscribeToTrack`). These reach into both as private state - the alternative is
 * driving a full subscribe through a stub RTCPeerConnection whose `addTransceiver` always returns the
 * same mid, which would not let two shares exist at once. Reaching in directly is what makes the
 * "two shares, two numbers" cases possible to state at all.
 *
 * Keyed by share id, not user id - see `inbound-fps.ts`'s module doc.
 * `CallSessionService.onScreenShareStarted` dedupes incoming shares by `shareId` alone, so a stale
 * share can briefly sit in the model alongside its replacement under the same `userId` (a rapid
 * stop/restart race); the "same user, two shares" case below is exactly that scenario.
 */
describe('inbound screen-share fps', () => {
    function internals(service: CallWebRtcService) {
        return service as unknown as {
            pc: {getStats(): Promise<Map<string, unknown>>} | null;
            midMap: Map<string, {userId: string; kind: 'audio' | 'video' | 'screen'; shareId?: string}>;
            pollStats(): Promise<void>;
        };
    }

    function inboundRtpVideo(mid: string, framesPerSecond?: number) {
        return {type: 'inbound-rtp', kind: 'video', mid, framesPerSecond};
    }

    it('reports a remote share fps keyed by share id once a stat carries one', async () => {
        const {service} = setup();
        const internal = internals(service);
        internal.midMap.set('m1', {userId: 'them', kind: 'screen', shareId: 'share-1'});
        internal.pc = {getStats: async () => new Map([['s1', inboundRtpVideo('m1', 24)]])};

        await internal.pollStats();

        expect(service.inboundVideoFpsByShare()).toEqual({'share-1': 24});
    });

    it('gives two concurrent remote shares (different users) two independent fps numbers', async () => {
        const {service} = setup();
        const internal = internals(service);
        internal.midMap.set('m1', {userId: 'them-a', kind: 'screen', shareId: 'share-a'});
        internal.midMap.set('m2', {userId: 'them-b', kind: 'screen', shareId: 'share-b'});
        internal.pc = {
            getStats: async () => new Map([
                ['s1', inboundRtpVideo('m1', 30)],
                ['s2', inboundRtpVideo('m2', 12)],
            ]),
        };

        await internal.pollStats();

        expect(service.inboundVideoFpsByShare()).toEqual({'share-a': 30, 'share-b': 12});
    });

    /**
     * The exact case the review round exists for: a stale share lingering across a rapid
     * stop/restart race sits alongside its replacement under the same userId. Keyed by user, one of
     * these two would have silently reported the other's number.
     */
    it('gives two shares from the SAME remote user two independent fps numbers', async () => {
        const {service} = setup();
        const internal = internals(service);
        internal.midMap.set('m1', {userId: 'them', kind: 'screen', shareId: 'share-old'});
        internal.midMap.set('m2', {userId: 'them', kind: 'screen', shareId: 'share-new'});
        internal.pc = {
            getStats: async () => new Map([
                ['s1', inboundRtpVideo('m1', 5)],
                ['s2', inboundRtpVideo('m2', 30)],
            ]),
        };

        await internal.pollStats();

        expect(service.inboundVideoFpsByShare()).toEqual({'share-old': 5, 'share-new': 30});
    });

    it('leaves a share out rather than reporting 0 while its stat has not arrived yet', async () => {
        const {service} = setup();
        const internal = internals(service);
        internal.midMap.set('m1', {userId: 'them', kind: 'screen', shareId: 'share-1'});
        internal.pc = {getStats: async () => new Map([['s1', inboundRtpVideo('m1', undefined)]])};

        await internal.pollStats();

        expect(service.inboundVideoFpsByShare()).toEqual({});
    });

    it('clears a share that stops appearing in the report, rather than keeping its last number', async () => {
        const {service} = setup();
        const internal = internals(service);
        internal.midMap.set('m1', {userId: 'them', kind: 'screen', shareId: 'share-1'});
        internal.pc = {getStats: async () => new Map([['s1', inboundRtpVideo('m1', 24)]])};
        await internal.pollStats();
        expect(service.inboundVideoFpsByShare()).toEqual({'share-1': 24});

        internal.pc = {getStats: async () => new Map()};
        await internal.pollStats();

        expect(service.inboundVideoFpsByShare()).toEqual({});
    });
});


/**
 * A stream's volume is its own gain, independent of its owner's voice - the gap task 6 closes.
 * `setUserVolume`/`getUserVolume` already had this shape for voice; these pin the mirrored
 * `setScreenVolume`/`getScreenVolume` pair, and - the requirement most likely to get missed - that
 * muting a stream never destroys the level stored for it.
 */
describe('stream volume', () => {
    function subscribeScreenAudio(service: CallWebRtcService, userId: string, trackName: string) {
        return (service as unknown as {
            subscribeToTrack(u: string, s: string, t: string, k: 'screenAudio'): Promise<void>;
        }).subscribeToTrack(userId, 'cf-theirs', trackName, 'screenAudio');
    }

    it('defaults to full volume for a stream nothing has touched', () => {
        const {service} = setup();
        expect(service.getScreenVolume('them')).toBe(1);
    });

    it('remembers a level set before the share is even subscribed', async () => {
        const {service, engineVolume, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: 'cf-rust', trackName: 'audio'} as VoiceSession);

        service.setScreenVolume('them', 0.4);
        expect(service.getScreenVolume('them')).toBe(0.4);

        await subscribeScreenAudio(service, 'them', 'screen-audio-abc');

        // Applied to the share's mixer source (the track name), not the participant's voice.
        expect(engineVolume).toHaveBeenCalledWith('screen-audio-abc', 0.4);
        expect(engineVolume).not.toHaveBeenCalledWith('them', 0.4);
    });

    it('applies a volume change live once the share is already subscribed', async () => {
        const {service, engineVolume, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: 'cf-rust', trackName: 'audio'} as VoiceSession);
        await subscribeScreenAudio(service, 'them', 'screen-audio-abc');
        engineVolume.mockClear();

        service.setScreenVolume('them', 0.25);

        expect(engineVolume).toHaveBeenCalledWith('screen-audio-abc', 0.25);
    });

    it('clamps out-of-range input the same way setUserVolume does', () => {
        const {service} = setup();

        service.setScreenVolume('them', 4);
        expect(service.getScreenVolume('them')).toBe(1);

        service.setScreenVolume('them', -1);
        expect(service.getScreenVolume('them')).toBe(0);
    });

    /**
     * Mute and volume are independent controls. Muting must not zero the stored level, and
     * unmuting must bring back exactly what was set - not unity, which is what a naive
     * "mute = set gain to 0, unmute = set gain to 1" implementation would do, and the bug would
     * only show up on the *second* unmute.
     */
    it('round-trips the stored volume through a mute and an unmute', async () => {
        const {service, engineVolume, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: 'cf-rust', trackName: 'audio'} as VoiceSession);
        await subscribeScreenAudio(service, 'them', 'screen-audio-abc');
        service.setScreenVolume('them', 0.6);
        engineVolume.mockClear();

        service.toggleScreenAudioMute('them');
        expect(engineVolume).toHaveBeenCalledWith('screen-audio-abc', 0);
        // The stored preference survives the mute - it is the mute overlay that changed, not it.
        expect(service.getScreenVolume('them')).toBe(0.6);

        service.toggleScreenAudioMute('them');
        expect(engineVolume).toHaveBeenLastCalledWith('screen-audio-abc', 0.6);
        expect(service.getScreenVolume('them')).toBe(0.6);
    });

    it('does not apply a volume change made while the stream is muted, but remembers it for unmute', async () => {
        const {service, engineVolume, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: 'cf-rust', trackName: 'audio'} as VoiceSession);
        await subscribeScreenAudio(service, 'them', 'screen-audio-abc');
        service.toggleScreenAudioMute('them'); // mute
        engineVolume.mockClear();

        service.setScreenVolume('them', 0.7);
        expect(engineVolume).not.toHaveBeenCalled();

        service.toggleScreenAudioMute('them'); // unmute
        expect(engineVolume).toHaveBeenCalledWith('screen-audio-abc', 0.7);
    });
});

/**
 * The session request used to be awaited with no `try`, in a method driven from an effect as
 * `void this.connect(...)`. A refusal therefore had no call site to land at: it surfaced as an
 * unhandled rejection in the console, said nothing to the user, and left `callId` set - which is the
 * re-entry guard, so every later attempt was blocked by the one that failed.
 */
describe('a call session the server will not open', () => {
    it('says so rather than failing silently', async () => {
        const {service} = setup({
            cfCreateSession: () => throwError(() => new HttpErrorResponse({status: 503})),
        });
        await tick();

        expect(TestBed.inject(ToastService).error).toHaveBeenCalledWith('CALL.CONNECT_FAILED');
        // Torn down rather than left half-built: `rtcState` reads 'connected' the moment the Rust
        // engine is up, and a call that never opened a session must not report itself as one.
        expect(service.rtcState()).toBe('new');
    });

    /** An entitlement refusal is its own sentence, naming which side bound. */
    it('names an entitlement refusal', async () => {
        setup({
            cfCreateSession: () => throwError(() => new HttpErrorResponse({
                status: 403,
                error: {
                    code: 'guild_plan_limit', key: 'voice.max_participants',
                    reason: 'guild_plan_limit', boundBy: 'guild', remedy: 'upgrade_guild',
                    actorCanRemedy: false, subject: {kind: 'guild', id: 'guild-1'}, retryable: false,
                },
            })),
        });
        await tick();

        expect(TestBed.inject(ToastService).error)
            .toHaveBeenCalledWith('ENTITLEMENT.REASON.GUILD_PLAN_LIMIT');
    });
});

/**
 * Per-stream bitrate on a remote share, and the deliberate twin of the block on
 * `voice-rtc.service.spec.ts`.
 *
 * <p>`inboundStatsFor` sees one report and a rate needs two samples, so it carries the cumulative
 * `bytesReceived` and this service differentiates successive polls into `kbps`. Without that second
 * half the panel renders no bitrate row at all on any remote share of a DM call.</p>
 */
describe('the inspected inbound bitrate', () => {
    function internals(s: CallWebRtcService) {
        return s as unknown as {
            pc: {getStats(): Promise<Map<string, unknown>>} | null;
            midMap: Map<string, {userId: string; kind: string; shareId?: string}>;
            pollStats(): Promise<void>;
            stopStatsPolling(): void;
        };
    }

    /** An inbound stat carrying a cumulative byte counter, as a real report does. */
    function inboundRtpBytes(mid: string, bytesReceived: number) {
        return {type: 'inbound-rtp', kind: 'video', mid, id: `in-${mid}`, bytesReceived};
    }

    function inspect(s: CallWebRtcService, bytes: number[]): {poll: () => Promise<void>} {
        const internal = internals(s);
        internal.midMap.set('m1', {userId: 'user_a', kind: 'screen', shareId: 'share_a'});
        let index = 0;
        internal.pc = {
            getStats: async () =>
                new Map([['s1', inboundRtpBytes('m1', bytes[Math.min(index++, bytes.length - 1)])]]),
        };
        s.inspected.set({shareId: 'share_a', userId: 'user_a'});
        return {poll: () => internal.pollStats()};
    }

    /**
     * The wall clock is stubbed directly rather than driven through fake timers.
     *
     * <p>Advancing a faked clock also fires every other timer this service has outstanding - the
     * connect chain's retries and the stats interval itself - so the poll under test would be
     * racing reruns of itself and the interval that resets the very state being measured. Stubbing
     * `Date.now` moves only the thing the rate arithmetic reads.</p>
     */
    const START = 1_700_000_000_000;
    let clock: MockInstance<() => number>;

    beforeEach(() => {
        clock = vi.spyOn(Date, 'now').mockReturnValue(START);
    });

    afterEach(() => clock.mockRestore());

    it('reports no rate on the first poll rather than claiming the stream is silent', async () => {
        const {service} = setup();
        const {poll} = inspect(service, [125_000]);

        await poll();

        expect(service.inspectedStats()?.layers[0].kbps).toBeUndefined();
    });

    it('differentiates two successive polls into kbps', async () => {
        const {service} = setup();
        const {poll} = inspect(service, [0, 125_000]);

        await poll();
        clock.mockReturnValue(START + 1000);
        await poll();

        // 125000 bytes in one second is 1000 kbps.
        expect(service.inspectedStats()?.layers[0].kbps).toBe(1000);
    });

    /**
     * A panel reopened minutes later must differentiate against a fresh baseline. Against a counter
     * from the previous call the first reading would be one absurd spike - and against a counter
     * that has since been reset it would floor at zero, which reads as a dead stream.
     */
    it('forgets its previous sample when polling stops', async () => {
        const {service} = setup();
        const {poll} = inspect(service, [0, 125_000]);

        await poll();
        internals(service).stopStatsPolling();
        service.inspected.set({shareId: 'share_a', userId: 'user_a'});
        clock.mockReturnValue(START + 1000);
        await poll();

        expect(service.inspectedStats()?.layers[0].kbps).toBeUndefined();
    });

    /**
     * `stopStatsPolling` clears the inspection itself. This service is `providedIn: 'root'`, so an
     * inspection left set by a tile destroyed with its panel open would pin `armStatsInterval` at
     * its 1s diagnostics cadence for every later call of the session, not just this one.
     */
    it('clears the inspection when polling stops', () => {
        const {service} = setup();
        service.inspected.set({shareId: 'share_a', userId: 'user_a'});

        internals(service).stopStatsPolling();

        expect(service.inspected()).toBeNull();
    });
});
