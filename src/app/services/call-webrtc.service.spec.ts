/**
 * A DM call after the LiveKit migration: what this service still owns, and the two seams the
 * migration moved.
 *
 * <p>The audio half is unchanged and is still covered here - it never touched the peer connection
 * that has gone, because it is pulled onto the Rust room and mixed there. What is new is the video
 * half: a roster of wanted track *names* diffed against what the SDK reports it is holding, and a
 * publish that is declared over HTTP rather than negotiated.</p>
 */
import type {MockInstance} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {Observable, of, Subject, throwError} from 'rxjs';
import {HttpErrorResponse} from '@angular/common/http';
import {signal} from '@angular/core';
import {ConnectionState as LiveKitConnectionState} from 'livekit-client';
import {CallWebRtcService, SESSION_WAIT_DELAYS_MS} from './call-webrtc.service';
import {CallSessionService} from './call-session.service';
import {VoiceService} from './voice.service';
import {LiveKitRoomService, RemoteMediaTrack} from './livekit-room.service';
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

/** Long enough for `awaitSession` to exhaust its schedule. */
const PAST_ALL_RETRIES = SESSION_WAIT_DELAYS_MS.reduce((a, b) => a + b, 0) + 200;

/**
 * jsdom has no `MediaStream`, and the attach path builds one per arriving track. Only the identity
 * of the tracks it was constructed with matters to any assertion here.
 */
class FakeMediaStream {
    constructor(readonly tracks: MediaStreamTrack[] = []) {
    }

    getVideoTracks(): MediaStreamTrack[] {
        return this.tracks.filter(t => t.kind !== 'audio');
    }
}

beforeEach(() => {
    (globalThis as unknown as {MediaStream: unknown}).MediaStream = FakeMediaStream;
});

/**
 * A local capture, with the two things the publish path reads off it.
 *
 * <p>`applyConstraints` moves what `getSettings` answers, as a real one does. That is load-bearing
 * for the degradation case: the re-declaration reads the track again rather than echoing the
 * granted numbers back, so a stub whose settings never moved would pass a service that applied
 * nothing.</p>
 */
function localTrack(settings: {height?: number; frameRate?: number} = {height: 720, frameRate: 30}) {
    const current = {...settings};
    return {
        kind: 'video',
        getSettings: () => current,
        applyConstraints: vi.fn(async (c: MediaTrackConstraints) => {
            if (typeof c.height === 'number') current.height = c.height;
            if (typeof c.frameRate === 'number') current.frameRate = c.frameRate;
        }),
        stop: vi.fn(),
    } as unknown as MediaStreamTrack & {applyConstraints: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>};
}

/**
 * One track the room reports it is holding.
 *
 * <p>`stats` is what that receiver's own `getRTCStatsReport()` answers - a per-receiver report is
 * the only place a mid can be read now that nothing here owns a transceiver.</p>
 */
function remoteTrack(options: {
    sid: string;
    name: string;
    userId: string;
    stats?: Record<string, unknown>[];
    attached?: boolean;
}): RemoteMediaTrack {
    const media = options.attached === false ? undefined : {
        mediaStreamTrack: {kind: 'video', id: options.sid} as MediaStreamTrack,
        getRTCStatsReport: async () =>
            new Map((options.stats ?? []).map((s, i) => [`s${i}`, s])) as unknown as RTCStatsReport,
    };
    return {
        trackSid: options.sid,
        identity: `${options.userId}#view`,
        userId: options.userId,
        publication: {trackSid: options.sid, trackName: options.name, track: media},
    } as unknown as RemoteMediaTrack;
}

function setup(options: {
    connection?: (callId: string, primary?: boolean, tag?: string) => Observable<unknown>;
    publish?: () => Observable<unknown>;
} = {}) {
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
        participants: {userId: string; isLocal: boolean; videoStream?: unknown}[];
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
    // Answers differently per (primary, tag), because the whole point of the two fetches is that
    // they are two: one identity each. A stub that answered identically would let a service that
    // reused one connection for both pass.
    const connection = vi.fn(options.connection ?? ((_id: string, primary = true, tag?: string) => of({
        backend: 'livekit',
        url: primary ? 'wss://sfu.test/primary' : 'wss://sfu.test/view',
        token: primary ? 'tok-primary' : 'tok-view',
        room: 'call-1',
        identity: primary ? 'me' : `me#${tag}`,
        mediaSessionId: primary ? 'me' : `me#${tag}`,
        expiresAt: '',
        canPublishAudio: true, canPublishVideo: true,
    })));
    const publish = vi.fn(options.publish ?? (() => of({
        identity: 'me#view', rung: null, height: null, framerate: null, maxLayer: null,
    })));
    const unpublish = vi.fn(() => of(undefined));
    const declareVideo = vi.fn(() => of({changed: true, maxLayer: null}));

    // Never resolves on its own - the test decides when the publication exists, which is the whole
    // window the subscribe tests cover.
    let resolveStart: (s: VoiceSession) => void = () => undefined;
    const started = new Promise<VoiceSession>(r => {
        resolveStart = r;
    });

    const remoteTracks = signal<ReadonlyMap<string, RemoteMediaTrack>>(new Map());
    // What the SFU has announced, subscribed or not. The only bridge from a roster row's track name
    // to the sid `setSubscribed` addresses.
    const publications = signal<Record<string, {trackSid: string; trackName: string}[]>>({});
    const livekit = {
        remoteTracks,
        state: signal(LiveKitConnectionState.Connected),
        connect: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        setSubscribed: vi.fn(() => true),
        setLayer: vi.fn(() => false),
        userOf: (identity: string) => identity.split('#')[0],
        publicationsOf: vi.fn((userId: string) => publications()[userId] ?? []),
        publishTrack: vi.fn(async () => undefined),
        unpublishTrack: vi.fn(async () => undefined),
    };

    const toggleCamera = vi.fn(async () => undefined);
    const toggleScreenShare = vi.fn(async () => undefined);
    const engineStart = vi.fn(() => started);

    TestBed.configureTestingModule({
        providers: [
            {
                provide: CallSessionService,
                useValue: {
                    session,
                    screenPreset: () => null,
                    pttGateOpen: () => true,
                    toggleCamera,
                    toggleScreenShare,
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
                    connection,
                    publish,
                    unpublish,
                    declareVideo,
                    getCall: vi.fn(() => of({status: 'Connected', participants: [{userId: 'me'}]})),
                    getCallSnapshot,
                },
            },
            {provide: LiveKitRoomService, useValue: livekit},
            {
                provide: VoiceWebsocketService,
                useValue: {
                    ...ws, connectionState: () => 2, invokeVoiceHeartbeat: vi.fn(),
                    invokeMuteChange: vi.fn(), invokeCameraChanged: vi.fn(),
                    invokeScreenShareStarted: vi.fn(), invokeScreenShareStopped: vi.fn(),
                },
            },
            {provide: AudioSettingsService, useValue: {buildVideoConstraint: vi.fn(async () => true)}},
            {provide: RustMediaService, useValue: {stopScreenCapture: vi.fn(), stopScreenPublish: vi.fn()}},
            {provide: ScreenPickerService, useValue: {show: vi.fn()}},
            {
                provide: VoiceEngineService,
                useValue: {
                    start: engineStart,
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
    return {
        service, ws, session, livekit, remoteTracks, publications, engineSubscribe, engineVolume, getCallSnapshot,
        connection, publish, unpublish, declareVideo, toggleCamera, toggleScreenShare, engineStart,
        resolveStart: (s: VoiceSession) => resolveStart(s),
    };
}

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms));

/** Reaches the private subscribe directly: the announcement paths that call it are already covered. */
function subscribeAudio(service: CallWebRtcService, userId: string): Promise<void> {
    return (service as unknown as {
        subscribeToTrack(u: string, s: string, t: string, k: 'audio'): Promise<void>;
    }).subscribeToTrack(userId, 'them', 'audio', 'audio');
}

/**
 * Two connections, one identity each. The SFU keys participants by identity and disconnects the
 * earlier session under a duplicate, so a client that reused one connection for the Rust room and
 * the webview room would kick its own call off the air - the single most dangerous mistake
 * available here, and it looks like it works right up until the microphone dies.
 */
describe('joining the room', () => {
    it('fetches a primary for Rust and a secondary for this room, and they are distinct', async () => {
        const {livekit, connection, engineStart} = setup();
        await tick();

        // The bare identity, for the connection the roster records as the participant.
        expect(connection).toHaveBeenCalledWith('call-1', true);
        // `{userId}#view`, for the room that only receives.
        expect(connection).toHaveBeenCalledWith('call-1', false, 'view');
        expect(connection).toHaveBeenCalledTimes(2);

        // Each goes where it belongs, and nowhere else.
        expect(engineStart).toHaveBeenCalledWith(
            {kind: 'call', callId: 'call-1'}, expect.any(String), expect.any(String), 'dev-1',
            {url: 'wss://sfu.test/primary', token: 'tok-primary'});
        expect(livekit.connect)
            .toHaveBeenCalledWith({url: 'wss://sfu.test/view', token: 'tok-view'});
    });

    /**
     * The rights are decided when the token is minted and enforced by the node, so a button drawn
     * from this client's own arithmetic would be a button that does nothing.
     */
    it('renders the publish grants from the connection rather than computing them', async () => {
        // Deliberately impossible - the rights are a fact about the user and the room, so the two
        // connections always agree in reality. Splitting them here is the only way to observe that
        // each grant is read off the connection that would exercise it: the microphone publishes on
        // the primary, the camera on this room.
        const {service} = setup({
            connection: (_id, primary = true) => of({
                backend: 'livekit', url: 'wss://sfu.test', token: 'tok', room: 'call-1',
                identity: 'me', mediaSessionId: 'me', expiresAt: '',
                canPublishAudio: primary, canPublishVideo: !primary,
            }),
        });
        await tick();

        expect(service.canPublishAudio()).toBe(true);
        expect(service.canPublishVideo()).toBe(true);
    });
});

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

        resolveStart({slot: 'slot-1', mediaSessionId: '', trackName: 'audio'} as VoiceSession);
        await pending;

        expect(engineSubscribe).toHaveBeenCalledWith(
            expect.objectContaining({slot: 'slot-1'}), 'them', 'them', 'audio');
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
        resolveStart({slot: 'slot-1', mediaSessionId: '', trackName: 'audio'} as VoiceSession);
        await subscribeAudio(service, 'them');

        expect(engineSubscribe).toHaveBeenCalledTimes(1);
    }, PAST_ALL_RETRIES + 5_000);

    /** Once it has actually worked, a repeat announcement is a duplicate and must not resubscribe. */
    it('does not subscribe twice for the same participant', async () => {
        const {service, engineSubscribe, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: '', trackName: 'audio'} as VoiceSession);

        await subscribeAudio(service, 'them');
        await subscribeAudio(service, 'them');

        expect(engineSubscribe).toHaveBeenCalledTimes(1);
    });

    /**
     * The stale-subscription apparatus is gone with the SDP relay: there is no subscribe request
     * left for the backend to refuse and no minted session id to go stale (design §8). So what
     * reaches this catch is genuine transport failure - roll the guard back so the next roster read
     * retries, and do <b>not</b> turn it into a refetch, which is what the old code did for a 409
     * and would now fire on every dropped packet.
     */
    it('releases the guard on a failed subscribe without refetching the snapshot', async () => {
        const {service, engineSubscribe, getCallSnapshot, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: '', trackName: 'audio'} as VoiceSession);
        // connect() reads the snapshot itself once the room is up; let that land before clearing.
        await tick();
        engineSubscribe.mockRejectedValueOnce({status: 502, error: {error: 'sfuRejected'}});
        getCallSnapshot.mockClear();

        await subscribeAudio(service, 'them');
        expect(getCallSnapshot).not.toHaveBeenCalled();

        await subscribeAudio(service, 'them');
        expect(engineSubscribe).toHaveBeenCalledTimes(2);
    });
});

/**
 * A share's own sound is a second track, and a second *source* - the participant's voice and the
 * audio of the stream they are sharing have to be mutable independently. It goes to the Rust mixer
 * like every other audio track in the call, never onto this room.
 */
describe('screen-share audio', () => {
    function subscribeScreenAudio(service: CallWebRtcService, userId: string, trackName: string) {
        return (service as unknown as {
            subscribeToTrack(u: string, s: string, t: string, k: 'screenAudio'): Promise<void>;
        }).subscribeToTrack(userId, 'them', trackName, 'screenAudio');
    }

    /**
     * Keyed by track name, not user id. Sharing the key with the voice source is what would make
     * muting a noisy stream also mute the person sharing it.
     */
    it('pulls the share audio as its own mixer source', async () => {
        const {service, engineSubscribe, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: '', trackName: 'audio'} as VoiceSession);

        await subscribeScreenAudio(service, 'them', 'screen-audio-abc');

        expect(engineSubscribe).toHaveBeenCalledWith(
            expect.objectContaining({slot: 'slot-1'}), 'screen-audio-abc', 'them', 'screen-audio-abc');
    });

    it('mutes one participant stream without touching their voice', async () => {
        const {service, engineVolume, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: '', trackName: 'audio'} as VoiceSession);
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
        resolveStart({slot: 'slot-1', mediaSessionId: '', trackName: 'audio'} as VoiceSession);

        service.toggleScreenAudioMute('them');
        await subscribeScreenAudio(service, 'them', 'screen-audio-second');

        expect(engineVolume).toHaveBeenCalledWith('screen-audio-second', 0);
    });
});

/**
 * The video half. The roster names tracks; the SDK reports sids. This service holds the demand and
 * moves one subscription per difference - never a rebuild, which would cost every tile a keyframe
 * whenever one person turned a camera on.
 */
describe('reconciling remote video', () => {
    function want(service: CallWebRtcService, name: string, userId: string, shareId: string | null) {
        (service as unknown as {
            wantVideo(n: string, w: {userId: string; kind: 'video' | 'screen'; shareId: string | null}): void;
        }).wantVideo(name, {userId, kind: shareId ? 'screen' : 'video', shareId});
    }

    /**
     * The roster speaks track names and `setSubscribed` addresses sids, so the announced
     * publications are the only bridge between them. A name the SFU has not announced yet is a race
     * between SignalR and the signalling socket, not an error - it is counted and retried.
     */
    it('resolves a roster row to the sid the SFU announced', async () => {
        const {service, livekit, publications} = setup();
        await tick();

        want(service, 'video', 'them', null);
        expect(livekit.setSubscribed).not.toHaveBeenCalledWith(expect.anything(), true);
        expect(service.unresolvedVideo()).toBe(1);

        publications.set({them: [{trackSid: 'TR_1', trackName: 'video'}]});
        want(service, 'video', 'them', null);

        expect(livekit.setSubscribed).toHaveBeenCalledWith('TR_1', true);
    });

    it('hands a subscribed camera to the session, and takes it back when the track goes', async () => {
        const {service, remoteTracks} = setup();
        await tick();
        const onCameraChanged = TestBed.inject(CallSessionService).onCameraChanged as unknown as ReturnType<typeof vi.fn>;

        want(service, 'video', 'them', null);
        remoteTracks.set(new Map([['t1', remoteTrack({sid: 't1', name: 'video', userId: 'them'})]]));
        TestBed.tick();

        expect(onCameraChanged).toHaveBeenCalledWith('them', true, expect.any(FakeMediaStream));

        onCameraChanged.mockClear();
        remoteTracks.set(new Map());
        TestBed.tick();

        expect(onCameraChanged).toHaveBeenCalledWith('them', false);
    });

    /**
     * The unsubscribe half, and the one a reconnect needs: a room that restored a broader
     * subscription than we asked for has to be narrowed back, so this runs over what the SDK
     * reports rather than over what we remember asking for.
     */
    it('drops a subscription the roster no longer wants', async () => {
        const {service, livekit, remoteTracks} = setup();
        await tick();

        want(service, 'screen-share-a', 'them', 'share-a');
        remoteTracks.set(new Map([
            ['t1', remoteTrack({sid: 't1', name: 'screen-share-a', userId: 'them'})],
            ['t2', remoteTrack({sid: 't2', name: 'screen-share-b', userId: 'them'})],
        ]));
        TestBed.tick();

        // Only the one nothing asked for.
        expect(livekit.setSubscribed).toHaveBeenCalledWith('t2', false);
        expect(livekit.setSubscribed).not.toHaveBeenCalledWith('t1', false);
    });

    /**
     * **Not this service's room, not this service's subscriptions.**
     *
     * <p>`LiveKitRoomService` is a root singleton and so is this service, which is constructed at app
     * bootstrap and lives for the whole session. Guild voice reconciles that same room through
     * `VoiceRTCService`. Without an ownership guard the effect that drives {@link reconcileVideo}
     * fires on *its* subscriptions too, finds a track no roster here names - there is no call, so
     * `wantedVideo` is empty - and unsubscribes it.</p>
     *
     * <p>That is what killed every remote camera and screen share in a guild channel. The track
     * arrived, the tile painted, and it was gone in the same tick, with no error and nothing in the
     * guild path's own logs because the teardown came from here.</p>
     */
    it('leaves the room alone when there is no call of its own', async () => {
        const {livekit, remoteTracks, session} = setup();
        await tick();
        // No call: exactly the state this service sits in for most of an app's life.
        session.set(null);
        await tick();
        livekit.setSubscribed.mockClear();

        // Guild voice pulls a camera onto the shared room.
        remoteTracks.set(new Map([
            ['t9', remoteTrack({sid: 't9', name: 'camera', userId: 'them'})],
        ]));
        TestBed.tick();

        expect(livekit.setSubscribed).not.toHaveBeenCalledWith('t9', false);
    });

    /**
     * On desktop the Rust room owns every audio track in the call, `screen-audio-*` included -
     * it is what feeds the mixer, and the per-stream mute and volume live there. A second transport
     * playing the same participant is double playout, and it is not muteable from any control the
     * user can see.
     */
    it('never plays a screen-audio track that turns up on this room', async () => {
        const {remoteTracks} = setup();
        await tick();
        const callSession = TestBed.inject(CallSessionService);

        remoteTracks.set(new Map([
            ['t1', remoteTrack({sid: 't1', name: 'screen-audio-abc', userId: 'them'})],
        ]));
        TestBed.tick();

        // Read through `describeTrack`, which tests `screen-audio-` before `screen-`: backwards,
        // this reads as the video of a share whose id is literally `audio-abc`.
        expect(callSession.onScreenShareStarted).not.toHaveBeenCalled();
        expect(callSession.onCameraChanged).not.toHaveBeenCalled();
    });

    /** A track the SDK reports before its media has attached is late, not broken. */
    it('waits for the media rather than attaching an empty stream', async () => {
        const {service, remoteTracks} = setup();
        await tick();
        const callSession = TestBed.inject(CallSessionService);

        want(service, 'video', 'them', null);
        remoteTracks.set(new Map([
            ['t1', remoteTrack({sid: 't1', name: 'video', userId: 'them', attached: false})],
        ]));
        TestBed.tick();

        expect(callSession.onCameraChanged).not.toHaveBeenCalled();
    });
});

/**
 * Publishing is a declaration now, not a negotiation. Three answers carry meaning: a plain 200, a
 * 200 that granted less than was asked for, and a 403 that could not grant anything at all.
 */
describe('declaring a local publication', () => {
    function publishCamera(service: CallWebRtcService, track: MediaStreamTrack) {
        return (service as unknown as {
            publishVideoTrack(s: MediaStream): Promise<void>;
        }).publishVideoTrack(new FakeMediaStream([track]) as unknown as MediaStream);
    }

    it('declares the track name and what the capture is actually sending', async () => {
        const {service, publish} = setup();
        await tick();

        await publishCamera(service, localTrack({height: 1080, frameRate: 60}));

        expect(publish).toHaveBeenCalledWith('call-1', {
            trackNames: ['video'], video: {height: 1080, framerate: 60},
        });
    });

    /**
     * Published before declared. The declaration is what puts this client on the roster as
     * publishing, so announcing a track the SFU is not yet carrying gives every peer a tile with
     * nothing behind it.
     */
    it('publishes on the room before declaring it, under the roster\'s name', async () => {
        const track = localTrack();
        const {service, livekit, publish} = setup();
        await tick();

        await publishCamera(service, track);

        expect(livekit.publishTrack).toHaveBeenCalledWith(track, 'video');
        expect(livekit.publishTrack.mock.invocationCallOrder[0])
            .toBeLessThan(publish.mock.invocationCallOrder[0]);
    });

    /** A share is a webview publication on the DM surface, unlike the guild one. */
    it('publishes a screen share under its share-scoped name', async () => {
        const track = localTrack();
        const {service, livekit, publish} = setup();
        await tick();

        await (service as unknown as {
            publishScreenTrack(id: string, s: MediaStream): Promise<void>;
        }).publishScreenTrack('share-1', new FakeMediaStream([track]) as unknown as MediaStream);

        expect(livekit.publishTrack).toHaveBeenCalledWith(track, 'screen-share-1');
        expect(publish).toHaveBeenCalledWith('call-1', expect.objectContaining({
            trackNames: ['screen-share-1'],
        }));
    });

    /**
     * A 200 with `degradations` is a publish that <b>worked, smaller</b>. Re-encode to the granted
     * rung and declare it again; roll nothing back, because the media is already flowing.
     */
    it('re-encodes to the granted rung and declares it again', async () => {
        const track = localTrack({height: 1080, frameRate: 60});
        const {service, declareVideo} = setup({
            publish: () => of({
                identity: 'me#view', rung: '720p30', height: 720, framerate: 30, maxLayer: null,
                degradations: [{key: 'voice.video', reason: 'guild_plan_limit'}],
            }),
        });
        await tick();

        await publishCamera(service, track);

        expect(track.applyConstraints).toHaveBeenCalledWith({height: 720, frameRate: 30});
        expect(declareVideo).toHaveBeenCalledWith('call-1', {height: 720, framerate: 30});
    });

    /**
     * A 403 is a refusal that could not degrade. The token this client connected with does not
     * permit it either, so nobody would receive the track whatever is retried - stop it, and put
     * the toggle back, because a camera button reading as live over a stopped track is worse than
     * the refusal.
     */
    it('stops the local track and puts the toggle back on a refusal', async () => {
        const track = localTrack();
        const {service, toggleCamera} = setup({
            publish: () => throwError(() => new HttpErrorResponse({
                status: 403,
                error: {
                    code: 'guild_plan_limit', key: 'voice.video',
                    reason: 'guild_plan_limit', boundBy: 'guild', remedy: 'upgrade_guild',
                    actorCanRemedy: false, subject: {kind: 'guild', id: 'guild-1'}, retryable: false,
                },
            })),
        });
        await tick();

        await publishCamera(service, track);

        expect(track.stop).toHaveBeenCalled();
        expect(toggleCamera).toHaveBeenCalled();
        expect(TestBed.inject(ToastService).error)
            .toHaveBeenCalledWith('ENTITLEMENT.REASON.GUILD_PLAN_LIMIT');
    });

    /** Peers drop a closed track rather than waiting on media that has ended. */
    it('marks the track closed when the camera goes off', async () => {
        const {service, unpublish} = setup();
        await tick();

        await (service as unknown as {unpublishVideoTrack(): Promise<void>}).unpublishVideoTrack();

        expect(unpublish).toHaveBeenCalledWith('call-1', ['video']);
    });
});

/**
 * `mediaSessionId` is the LiveKit identity now, and the Rust engine answers `""` for its own rather
 * than fabricating one. Empty is a legitimate value: only the absence of a publication says "not
 * publishing", and collapsing the two would have the server record us as silent while the
 * microphone is going out.
 */
describe('the heartbeat', () => {
    it('asserts the Rust publication even when its identity is empty', async () => {
        const {service, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: '', trackName: 'audio'} as VoiceSession);
        await tick();

        (service as unknown as {sendHeartbeat(): void}).sendHeartbeat();

        expect(TestBed.inject(VoiceWebsocketService).invokeVoiceHeartbeat).toHaveBeenCalledWith(
            'call-1', expect.objectContaining({mediaSessionId: '', audioTrackName: 'audio'}));
    });

    it('says nothing is published when there is no publication', async () => {
        const {service} = setup();
        await tick();

        (service as unknown as {sendHeartbeat(): void}).sendHeartbeat();

        expect(TestBed.inject(VoiceWebsocketService).invokeVoiceHeartbeat).toHaveBeenCalledWith(
            'call-1', expect.objectContaining({mediaSessionId: null, audioTrackName: null}));
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
        }).subscribeToTrack(userId, 'them', trackName, 'screenAudio');
    }

    it('defaults to full volume for a stream nothing has touched', () => {
        const {service} = setup();
        expect(service.getScreenVolume('them')).toBe(1);
    });

    it('remembers a level set before the share is even subscribed', async () => {
        const {service, engineVolume, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: '', trackName: 'audio'} as VoiceSession);

        service.setScreenVolume('them', 0.4);
        expect(service.getScreenVolume('them')).toBe(0.4);

        await subscribeScreenAudio(service, 'them', 'screen-audio-abc');

        // Applied to the share's mixer source (the track name), not the participant's voice.
        expect(engineVolume).toHaveBeenCalledWith('screen-audio-abc', 0.4);
        expect(engineVolume).not.toHaveBeenCalledWith('them', 0.4);
    });

    it('applies a volume change live once the share is already subscribed', async () => {
        const {service, engineVolume, resolveStart} = setup();
        resolveStart({slot: 'slot-1', mediaSessionId: '', trackName: 'audio'} as VoiceSession);
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
        resolveStart({slot: 'slot-1', mediaSessionId: '', trackName: 'audio'} as VoiceSession);
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
        resolveStart({slot: 'slot-1', mediaSessionId: '', trackName: 'audio'} as VoiceSession);
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
 * The connection request used to be awaited with no `try`, in a method driven from an effect as
 * `void this.connect(...)`. A refusal therefore had no call site to land at: it surfaced as an
 * unhandled rejection in the console, said nothing to the user, and left `callId` set - which is the
 * re-entry guard, so every later attempt was blocked by the one that failed.
 */
describe('a room the server will not open', () => {
    it('says so rather than failing silently', async () => {
        const {livekit} = setup({
            connection: () => throwError(() => new HttpErrorResponse({status: 503})),
        });
        await tick();

        expect(TestBed.inject(ToastService).error).toHaveBeenCalledWith('CALL.CONNECT_FAILED');
        // Torn down rather than left half-built. `callId` is the re-entry guard and the teardown is
        // the only thing that releases it - a room left half-open blocks every later attempt.
        expect(livekit.disconnect).toHaveBeenCalled();
    });

    /** An entitlement refusal is its own sentence, naming which side bound. */
    it('names an entitlement refusal', async () => {
        setup({
            connection: () => throwError(() => new HttpErrorResponse({
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
 * `pollStats` reads each subscribed receiver's own report and rebuilds the mid → owner map from the
 * same pass, because nothing here owns a transceiver any more. Keyed by share id, not user id - see
 * `inbound-fps.ts`'s module doc: `CallSessionService.onScreenShareStarted` dedupes incoming shares
 * by `shareId` alone, so a stale share can briefly sit in the model alongside its replacement under
 * the same `userId`, and the "same user, two shares" case below is exactly that.
 */
describe('inbound screen-share fps', () => {
    function inboundRtpVideo(mid: string, framesPerSecond?: number) {
        return {type: 'inbound-rtp', kind: 'video', id: `in-${mid}`, mid, framesPerSecond};
    }

    function poll(service: CallWebRtcService): Promise<void> {
        return (service as unknown as {pollStats(): Promise<void>}).pollStats();
    }

    it('reports a remote share fps keyed by share id once a stat carries one', async () => {
        const {service, remoteTracks} = setup();
        await tick();
        remoteTracks.set(new Map([['t1', remoteTrack({
            sid: 't1', name: 'screen-share-1', userId: 'them', stats: [inboundRtpVideo('m1', 24)],
        })]]));

        await poll(service);

        expect(service.inboundVideoFpsByShare()).toEqual({'share-1': 24});
    });

    it('gives two concurrent remote shares (different users) two independent fps numbers', async () => {
        const {service, remoteTracks} = setup();
        await tick();
        remoteTracks.set(new Map([
            ['t1', remoteTrack({
                sid: 't1', name: 'screen-share-a', userId: 'them-a', stats: [inboundRtpVideo('m1', 30)],
            })],
            ['t2', remoteTrack({
                sid: 't2', name: 'screen-share-b', userId: 'them-b', stats: [inboundRtpVideo('m2', 12)],
            })],
        ]));

        await poll(service);

        expect(service.inboundVideoFpsByShare()).toEqual({'share-a': 30, 'share-b': 12});
    });

    /**
     * The exact case the keying exists for: a stale share lingering across a rapid stop/restart race
     * sits alongside its replacement under the same userId. Keyed by user, one of these two would
     * have silently reported the other's number.
     */
    it('gives two shares from the SAME remote user two independent fps numbers', async () => {
        const {service, remoteTracks} = setup();
        await tick();
        remoteTracks.set(new Map([
            ['t1', remoteTrack({
                sid: 't1', name: 'screen-share-old', userId: 'them', stats: [inboundRtpVideo('m1', 5)],
            })],
            ['t2', remoteTrack({
                sid: 't2', name: 'screen-share-new', userId: 'them', stats: [inboundRtpVideo('m2', 30)],
            })],
        ]));

        await poll(service);

        expect(service.inboundVideoFpsByShare()).toEqual({'share-old': 5, 'share-new': 30});
    });

    it('leaves a share out rather than reporting 0 while its stat has not arrived yet', async () => {
        const {service, remoteTracks} = setup();
        await tick();
        remoteTracks.set(new Map([['t1', remoteTrack({
            sid: 't1', name: 'screen-share-1', userId: 'them', stats: [inboundRtpVideo('m1', undefined)],
        })]]));

        await poll(service);

        expect(service.inboundVideoFpsByShare()).toEqual({});
    });

    it('clears a share that stops appearing in the report, rather than keeping its last number', async () => {
        const {service, remoteTracks} = setup();
        await tick();
        remoteTracks.set(new Map([['t1', remoteTrack({
            sid: 't1', name: 'screen-share-1', userId: 'them', stats: [inboundRtpVideo('m1', 24)],
        })]]));
        await poll(service);
        expect(service.inboundVideoFpsByShare()).toEqual({'share-1': 24});

        remoteTracks.set(new Map());
        await poll(service);

        expect(service.inboundVideoFpsByShare()).toEqual({});
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
            pollStats(): Promise<void>;
            stopStatsPolling(): void;
        };
    }

    /** An inbound stat carrying a cumulative byte counter, as a real report does. */
    function inboundRtpBytes(mid: string, bytesReceived: number) {
        return {type: 'inbound-rtp', kind: 'video', mid, id: `in-${mid}`, bytesReceived};
    }

    function inspect(
        s: CallWebRtcService,
        remoteTracks: {set(v: ReadonlyMap<string, RemoteMediaTrack>): void},
        bytes: number[],
    ): {poll: () => Promise<void>} {
        let index = 0;
        remoteTracks.set(new Map([['t1', {
            trackSid: 't1',
            identity: 'user_a#view',
            userId: 'user_a',
            publication: {
                trackSid: 't1',
                trackName: 'screen-share_a',
                track: {
                    mediaStreamTrack: {kind: 'video'},
                    getRTCStatsReport: async () => new Map([
                        ['s1', inboundRtpBytes('m1', bytes[Math.min(index++, bytes.length - 1)])],
                    ]),
                },
            },
        } as unknown as RemoteMediaTrack]]));
        s.inspected.set({shareId: 'share_a', userId: 'user_a'});
        return {poll: () => internals(s).pollStats()};
    }

    /**
     * The wall clock is stubbed directly rather than driven through fake timers.
     *
     * <p>Advancing a faked clock also fires every other timer this service has outstanding - the
     * connect chain's waits and the stats interval itself - so the poll under test would be racing
     * reruns of itself and the interval that resets the very state being measured. Stubbing
     * `Date.now` moves only the thing the rate arithmetic reads.</p>
     */
    const START = 1_700_000_000_000;
    let clock: MockInstance<() => number>;

    beforeEach(() => {
        clock = vi.spyOn(Date, 'now').mockReturnValue(START);
    });

    afterEach(() => clock.mockRestore());

    it('reports no rate on the first poll rather than claiming the stream is silent', async () => {
        const {service, remoteTracks} = setup();
        await tick();
        const {poll} = inspect(service, remoteTracks, [125_000]);

        await poll();

        expect(service.inspectedStats()?.layers[0].kbps).toBeUndefined();
    });

    it('differentiates two successive polls into kbps', async () => {
        const {service, remoteTracks} = setup();
        await tick();
        const {poll} = inspect(service, remoteTracks, [0, 125_000]);

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
        const {service, remoteTracks} = setup();
        await tick();
        const {poll} = inspect(service, remoteTracks, [0, 125_000]);

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
