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
                    getCallSnapshot: vi.fn(() => of({
                        roomId: 'call-1', kind: 'call', guildId: null,
                        instanceId: 'inst-1', version: 1, participants: [],
                    })),
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
                    setUserVolume: vi.fn(async () => undefined),
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
    return {service, ws, engineSubscribe, resolveStart: (s: VoiceSession) => resolveStart(s)};
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
