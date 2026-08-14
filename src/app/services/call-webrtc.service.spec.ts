/**
 * The subscribe path of a DM call.
 *
 * Bug this covers: `subscribeToTrack` returned silently when the Rust publication did not exist
 * yet, and every announcement triggered by session creation arrives while `voiceEngine.start()` is
 * still pending - so the participant stayed inaudible for the whole call, with nothing to retry it.
 * The guild path has waited for its session since the Rust engine landed; this is the port.
 */
import {TestBed} from '@angular/core/testing';
import {of, Subject} from 'rxjs';
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

function setup() {
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
                    cfCreateSession: vi.fn(() => of({mediaSessionId: 'cf-web', backend: 'cloudflare'})),
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
            {provide: ToastService, useValue: {info: vi.fn(), httpError: vi.fn()}},
            {provide: OAuthService, useValue: {getAccessToken: () => 'tok'}},
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
