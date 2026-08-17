// No `vi.mock('@tauri-apps/api/core')`: one mock wins per run, so adding one changes other specs.
import type {MockInstance} from 'vitest';
import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {OAuthService} from 'angular-oauth2-oidc';
import {ConnectionState} from 'livekit-client';
import {of, Subject, throwError} from 'rxjs';
import {GuildVoiceService, VoiceConnectionDto, VoicePublishResponse} from './guild-voice.service';
import {LiveKitRoomService, RemoteMediaTrack} from './livekit-room.service';
import {CAMERA_TRACK, SUBSCRIBE_RETRY_DELAYS_MS, trackIntent, VoiceRTCService} from './voice-rtc.service';
import {VoiceEngineService} from './voice-engine.service';
import {RustMediaService} from './rust-media.service';
import {ScreenPickerService} from './screen-picker.service';
import {DeviceIdentityService} from './device-identity.service';
import {bitrateFor} from '../models/stream-preset';
import {ApiConfigService} from './api-config.service';
import {AudioSettingsService} from './audio-settings.service';
import {EntitlementStore} from '../stores/entitlement.store';
import {EntitlementRungDto} from '../dtos/response/entitlement.dto';
import {VoiceLimitsService} from './voice-limits.service';

/** The `video_quality` ladder, exactly as the server publishes it. Never hardcoded in app code. */
const LADDER: EntitlementRungDto[] = [
    {rung: 'none', rank: 0, maxHeight: 0, maxFramerate: 0},
    {rung: '720p30', rank: 2, maxHeight: 720, maxFramerate: 30},
    {rung: '1080p60', rank: 4, maxHeight: 1080, maxFramerate: 60},
];

/** Stands in for the Rust engine. Only the calls these tests exercise are implemented. */
class FakeEngine {
    subscribe = vi.fn().mockResolvedValue(undefined);
    unsubscribe = vi.fn().mockResolvedValue(undefined);
    setUserVolume = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    start = vi.fn().mockResolvedValue({slot: 'primary', mediaSessionId: '', trackName: 'audio'});
    available = () => false;
}

/** Stands in for `LiveKitRoomService`, plus the publish half of {@link RoomPublishing}. */
class FakeRoom {
    readonly state = signal(ConnectionState.Disconnected);
    readonly remoteTracks = signal<ReadonlyMap<string, RemoteMediaTrack>>(new Map());
    readonly refusedAudioSubscriptions = signal(0);
    readonly unrecognisedLayers = signal(0);
    /** Bumped whenever the room learns a publication exists - see {@link announce}. */
    readonly publications = signal(0);

    connect = vi.fn(async () => {
        this.state.set(ConnectionState.Connected);
    });
    disconnect = vi.fn(async () => {
        this.state.set(ConnectionState.Disconnected);
    });
    setSubscribed = vi.fn(() => true);
    setLayer = vi.fn(() => true);
    publishTrack = vi.fn(async () => undefined);
    unpublishTrack = vi.fn(async () => undefined);

    /** userId → what the room has been told this user publishes, subscribed or not. */
    private readonly published = new Map<string, {trackSid: string; trackName: string}[]>();

    publicationsOf = vi.fn((userId: string) => this.published.get(userId) ?? []);

    userOf(identity: string): string {
        const at = identity.indexOf('#');
        return at === -1 ? identity : identity.slice(0, at);
    }

    /** The SFU telling us a publication exists, which is what makes its sid knowable. */
    announce(userId: string, trackName: string, trackSid = `TR_${trackName}`): void {
        this.published.set(userId, [...(this.published.get(userId) ?? []), {trackSid, trackName}]);
        // The real room bumps this from `TrackPublished`/`ParticipantConnected`; without it a
        // reconcile-on-publication test would pass against a service that never reconciles.
        this.publications.update(n => n + 1);
    }

    /** A track this room has actually pulled, as `TrackSubscribed` would leave it. */
    hold(track: RemoteMediaTrack): void {
        this.remoteTracks.set(new Map(this.remoteTracks()).set(track.trackSid, track));
    }
}

/** A remote track as the room reports it. `track` is left off unless a test renders it. */
function remoteTrack(
    userId: string,
    trackName: string,
    publication: Record<string, unknown> = {},
): RemoteMediaTrack {
    return {
        trackSid: `TR_${trackName}`,
        identity: `${userId}#view`,
        userId,
        publication: {trackName, ...publication},
    } as unknown as RemoteMediaTrack;
}

/** Everything `POST .../voice/connection` answers, so a test can vary one field. */
function connectionReply(overrides: Partial<VoiceConnectionDto> = {}): VoiceConnectionDto {
    return {
        backend: 'livekit',
        url: 'wss://sfu-fsn1.venta.gg',
        token: 'jwt',
        room: 'guild:c1',
        identity: 'user_me#view',
        mediaSessionId: 'user_me#view',
        expiresAt: '2026-01-01T00:00:00Z',
        canPublishAudio: true,
        canPublishVideo: true,
        ...overrides,
    };
}

/** An ordinary publish reply: nothing capped, nothing reduced. */
function publishReply(overrides: Partial<VoicePublishResponse> = {}): VoicePublishResponse {
    return {
        identity: 'user_me#view',
        rung: null,
        height: null,
        framerate: null,
        maxLayer: null,
        ...overrides,
    };
}

let engine: FakeEngine;
let room: FakeRoom;
let service: VoiceRTCService;
/** Stands in for `RustMediaService.publishEnded$` - the publisher saying its share stopped. */
let publishEnded: Subject<void>;

/** The failure the room returns while the publisher's track has not reached it yet. */
const notFound = () => new Error('not_found_track_error');

const target = (userId = 'user_a', mediaSessionId = 'sess_1') => ({
    userId,
    mediaSessionId,
    trackName: 'audio',
});

/** The publication this channel's audio runs on. `mediaSessionId` is empty on purpose, not absent. */
const SESSION = {slot: 'primary', mediaSessionId: '', trackName: 'audio'};

beforeEach(() => {
    vi.useFakeTimers();
    engine = new FakeEngine();
    room = new FakeRoom();
    publishEnded = new Subject<void>();

    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: VoiceEngineService, useValue: engine},
            {provide: LiveKitRoomService, useValue: room},
            // Stubbed rather than real: its constructor reads localStorage, absent in jsdom here.
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://example.test'}},
            {
                provide: AudioSettingsService,
                useValue: {settings: () => ({}), buildVideoConstraint: async () => true},
            },
            // The service subscribes `publishEnded$` at construction, so a bare `{}` will not do.
            {provide: RustMediaService, useValue: {publishEnded$: publishEnded}},
            // `rememberPreset` is called by every quality change, so a bare `{}` throws on the first.
            {provide: ScreenPickerService, useValue: {rememberPreset: () => undefined}},
            {
                provide: DeviceIdentityService,
                useValue: {
                    get: vi.fn().mockResolvedValue('device'),
                    deviceId: vi.fn().mockResolvedValue('device'),
                },
            },
            {provide: OAuthService, useValue: {getAccessToken: () => 'token'}},
            // The ladder a room's video ceiling resolves against; nothing clamps until a snapshot
            // names a rung on it.
            {provide: EntitlementStore, useValue: {ladder: () => LADDER, ensureLoaded: () => void 0}},
        ],
    });
    service = TestBed.inject(VoiceRTCService);
    // Stands the service up as though `connect` had run, without the engine start or the round trip.
    Object.assign(service as unknown as Record<string, unknown>, {
        voiceSession: SESSION,
        voiceTarget: {guildId: 'g1', channelId: 'c1'},
        primaryConnection: {url: 'wss://sfu-fsn1.venta.gg', token: 'mic-jwt'},
    });
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

// ── The control plane ────────────────────────────────────────────────────────

/** One connection per user per tag: a reused tag shares an identity and the SFU evicts the first. */
describe('joining the room', () => {
    let connection: MockInstance;
    let publish: MockInstance;

    /** Answers a different url and token per connection, so mixing the two is visible. */
    function twoConnections(): void {
        connection.mockImplementation((_g: string, _c: string, primary = true, tag?: string) =>
            of(
                connectionReply(
                    primary
                        ? {url: 'wss://primary', token: 'mic-jwt', identity: 'user_me'}
                        : {url: 'wss://view', token: 'view-jwt', identity: `user_me#${tag}`},
                ),
            ),
        );
    }

    beforeEach(() => {
        const guildVoice = TestBed.inject(GuildVoiceService);
        connection = vi.spyOn(guildVoice, 'connection').mockReturnValue(of(connectionReply()));
        // Unmocked this hits the real `HttpClient`, which the testing backend never answers: a hang.
        publish = vi.spyOn(guildVoice, 'publish').mockReturnValue(of(publishReply()));
        Object.assign(service as unknown as Record<string, unknown>, {
            voiceTarget: null,
            primaryConnection: null,
        });
    });

    it('fetches one connection per identity', async () => {
        await service.connect('g1', 'c1');

        expect(connection).toHaveBeenNthCalledWith(1, 'g1', 'c1', true);
        expect(connection).toHaveBeenNthCalledWith(2, 'g1', 'c1', false, 'view');
        expect(connection).toHaveBeenCalledTimes(2);
    });

    /** Until this lands the server records no publisher, and every other client gates on that. */
    it('declares the microphone once the engine is up', async () => {
        await service.connect('g1', 'c1');

        expect(publish).toHaveBeenCalledWith('g1', 'c1', {trackNames: ['audio']});
    });

    /** And they must not be crossed: the microphone gets the primary, the room gets the secondary. */
    it('starts the microphone on the primary and the room on the secondary', async () => {
        twoConnections();

        await service.connect('g1', 'c1');

        expect(engine.start).toHaveBeenCalledWith(
            {kind: 'guild', guildId: 'g1', channelId: 'c1'},
            'https://example.test',
            'token',
            'device',
            {url: 'wss://primary', token: 'mic-jwt'},
        );
        expect(room.connect).toHaveBeenCalledWith({url: 'wss://view', token: 'view-jwt'});
    });

    it('hands the url and token straight to the room', async () => {
        await service.connect('g1', 'c1');

        expect(room.connect).toHaveBeenCalledWith({url: 'wss://sfu-fsn1.venta.gg', token: 'jwt'});
    });

    /** A room lives on one node, so a url kept from an earlier room reaches the wrong machine. */
    it('asks again rather than reusing the url it was given last time', async () => {
        await service.connect('g1', 'c1');
        service.teardown();
        connection.mockReturnValue(of(connectionReply({url: 'wss://sfu-ash1.venta.gg'})));

        await service.connect('g1', 'c2');

        expect(room.connect).toHaveBeenLastCalledWith({
            url: 'wss://sfu-ash1.venta.gg',
            token: 'jwt',
        });
    });

    /** Each flag comes from the connection that enforces it: the node decides, not our arithmetic. */
    it('renders each button from the connection that would enforce it', async () => {
        connection.mockImplementation((_g: string, _c: string, primary = true) =>
            of(connectionReply({canPublishAudio: !primary, canPublishVideo: primary})),
        );

        await service.connect('g1', 'c1');

        expect(service.canPublishAudio()).toBe(false);
        expect(service.canPublishVideo()).toBe(false);
    });

    /** Joining is complete once the microphone publishes; losing the view room is not a failed join. */
    it('stays joined when the view room cannot be reached', async () => {
        connection.mockImplementation((_g: string, _c: string, primary = true) =>
            primary ? of(connectionReply()) : throwError(() => new Error('no route')),
        );

        const joined = await service.connect('g1', 'c1');

        expect(joined).toBe(true);
        expect(service.rtcState()).toBe('connected');
    });

    /** The other direction: without the microphone's connection there is nothing to join for. */
    it("does not join when the microphone's connection cannot be minted", async () => {
        connection.mockImplementation((_g: string, _c: string, primary = true) =>
            primary ? throwError(() => new Error('no route')) : of(connectionReply()),
        );

        const joined = await service.connect('g1', 'c1');

        expect(joined).toBe(false);
        expect(engine.start).not.toHaveBeenCalled();
    });
});

// ── Subscriptions ────────────────────────────────────────────────────────────

/** Intent is held against the roster: an announcement arrives once, so a dropped one is permanent. */
describe('pulling remote video', () => {
    it('subscribes by the sid behind the roster row', async () => {
        room.announce('user_a', 'screen-abc');

        await service.subscribeVideo('g1', 'c1', 'user_a', 'sess_1', 'screen-abc', 'screen');

        expect(room.setSubscribed).toHaveBeenCalledWith('TR_screen-abc', true);
    });

    it('holds an announcement that beat the publication and applies it once it lands', async () => {
        await service.subscribeVideo('g1', 'c1', 'user_a', 'sess_1', 'screen-abc', 'screen');
        expect(room.setSubscribed).not.toHaveBeenCalled();

        // Nothing re-announces a roster event, so only the intent held above can still pull it.
        room.announce('user_a', 'screen-abc');
        service.handleRemoteTrackClosed(CAMERA_TRACK, 'user_b');

        expect(room.setSubscribed).toHaveBeenCalledWith('TR_screen-abc', true);
    });

    /** The publication landing is itself a reconcile; needing a second event here means the bug is back. */
    it('pulls a track the moment the room learns its publication, with nothing else happening', async () => {
        await service.subscribeVideo('g1', 'c1', 'user_a', 'sess_1', CAMERA_TRACK, 'video');
        expect(room.setSubscribed).not.toHaveBeenCalled();

        room.announce('user_a', CAMERA_TRACK);
        TestBed.tick();

        expect(room.setSubscribed).toHaveBeenCalledWith(`TR_${CAMERA_TRACK}`, true);
    });

    /** The Rust mixer already plays every microphone and `screen-audio-*` track: a second transport echoes. */
    it('never pulls an audio track onto this room', async () => {
        room.announce('user_a', 'screen-audio-abc');
        room.announce('user_a', 'audio');

        await service.subscribeVideo('g1', 'c1', 'user_a', 'sess_1', 'screen-audio-abc', 'screen');
        await service.subscribeVideo('g1', 'c1', 'user_a', 'sess_1', 'audio', 'video');

        expect(room.setSubscribed).not.toHaveBeenCalled();
    });

    /** `screen-audio-{id}` also satisfies `startsWith('screen-')`, so `describeTrack`'s order decides. */
    it('reads a share and its audio apart by the prefix, not by the argument', async () => {
        room.announce('user_a', 'screen-audio-abc');
        room.announce('user_a', 'screen-abc');

        // The caller passes `screen` for both halves; only the name decides.
        await service.subscribeVideo('g1', 'c1', 'user_a', 'sess_1', 'screen-audio-abc', 'screen');
        await service.subscribeVideo('g1', 'c1', 'user_a', 'sess_1', 'screen-abc', 'screen');

        expect(room.setSubscribed).toHaveBeenCalledTimes(1);
        expect(room.setSubscribed).toHaveBeenCalledWith('TR_screen-abc', true);
    });

    it('closes a track the roster no longer names', async () => {
        room.announce('user_a', 'screen-abc');
        await service.subscribeVideo('g1', 'c1', 'user_a', 'sess_1', 'screen-abc', 'screen');
        room.hold(remoteTrack('user_a', 'screen-abc'));
        room.setSubscribed.mockClear();

        service.handleRemoteTrackClosed('screen-abc', 'user_a');

        expect(room.setSubscribed).toHaveBeenCalledWith('TR_screen-abc', false);
    });

    /** By diffing, never by rebuilding: a rebuild re-pulls every tile and black-frames the room. */
    it('leaves a track that is still wanted alone when another one goes', async () => {
        room.announce('user_a', 'screen-abc');
        room.announce('user_b', CAMERA_TRACK);
        await service.subscribeVideo('g1', 'c1', 'user_a', 'sess_1', 'screen-abc', 'screen');
        await service.subscribeVideo('g1', 'c1', 'user_b', 'sess_2', CAMERA_TRACK, 'video');
        room.hold(remoteTrack('user_a', 'screen-abc'));
        room.hold(remoteTrack('user_b', CAMERA_TRACK));
        room.setSubscribed.mockClear();

        service.handleRemoteTrackClosed('screen-abc', 'user_a');

        expect(room.setSubscribed).not.toHaveBeenCalledWith(`TR_${CAMERA_TRACK}`, false);
    });

    it("stops wanting a departed participant's video", async () => {
        room.announce('user_a', 'screen-abc');
        await service.subscribeVideo('g1', 'c1', 'user_a', 'sess_1', 'screen-abc', 'screen');
        room.hold(remoteTrack('user_a', 'screen-abc'));
        room.setSubscribed.mockClear();

        service.cleanupParticipant('user_a');

        expect(room.setSubscribed).toHaveBeenCalledWith('TR_screen-abc', false);
        expect(service.subscribedUserIds()).not.toContain('user_a');
    });
});

/** `describeTrack` is the only thing that decides which map a track lands in. */
describe('projecting what the room holds', () => {
    class FakeMediaStream {
        constructor(readonly tracks: unknown[]) {}
    }

    beforeEach(() => {
        (globalThis as unknown as Record<string, unknown>)['MediaStream'] = FakeMediaStream;
    });

    function held(userId: string, trackName: string): RemoteMediaTrack {
        return remoteTrack(userId, trackName, {track: {mediaStreamTrack: {id: trackName}}});
    }

    it('files a share under its owner on the screen map', () => {
        room.hold(held('user_a', 'screen-abc'));
        TestBed.tick();

        expect(service.getScreenStream('user_a')).not.toBeNull();
        expect(service.getVideoStream('user_a')).toBeNull();
    });

    it('files a camera on the video map', () => {
        room.hold(held('user_a', CAMERA_TRACK));
        TestBed.tick();

        expect(service.getVideoStream('user_a')).not.toBeNull();
        expect(service.getScreenStream('user_a')).toBeNull();
    });

    /** A track that stops has to leave the map on its own, not linger at its last frame. */
    it('drops a stream the room no longer holds', () => {
        room.hold(held('user_a', 'screen-abc'));
        TestBed.tick();

        room.remoteTracks.set(new Map());
        TestBed.tick();

        expect(service.getScreenStream('user_a')).toBeNull();
    });
});

// ── Audio, which is still the Rust room's ────────────────────────────────────

/** A backfilled announcement can beat `voiceSession`, and announcements are never repeated. */
it('waits for the session rather than dropping an announcement that beat it', async () => {
    (service as unknown as {voiceSession: unknown}).voiceSession = null;

    const done = service.subscribeAudio([target()]);
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

/** The roster can announce a publisher before the SFU's `TrackPublished` reaches the Rust room. */
it('retries a subscribe that beat the publication into the Rust room', async () => {
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

    // One initial attempt plus one per delay, so a participant who never publishes leaves no timer.
    expect(engine.subscribe).toHaveBeenCalledTimes(SUBSCRIBE_RETRY_DELAYS_MS.length + 1);
    expect(service.participantsWithAudio()).not.toContain('user_a');
});

it('stops retrying when the participant leaves mid-backoff', async () => {
    engine.subscribe.mockRejectedValue(notFound());

    const done = service.subscribeAudio([target()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.subscribe).toHaveBeenCalledTimes(1);

    service.cleanupParticipant('user_a');
    await drainRetries();
    await done;

    // Resubscribing someone who has left leaves a mixer source nothing will ever remove.
    expect(engine.subscribe).toHaveBeenCalledTimes(1);
});

it('drops a subscription that completed after the participant left', async () => {
    // The failure the token guard exists for: the call is in flight, not sleeping, when they go.
    let settle: () => void = () => {};
    engine.subscribe.mockImplementationOnce(
        () =>
            new Promise<void>(r => {
                settle = r;
            }),
    );

    const done = service.subscribeAudio([target()]);
    await vi.advanceTimersByTimeAsync(0);

    service.cleanupParticipant('user_a');
    settle();
    await done;

    expect(engine.unsubscribe).toHaveBeenCalledWith(SESSION, 'user_a');
    expect(service.participantsWithAudio()).not.toContain('user_a');
});

it('ignores a repeated announcement for an identity it is already pulling', async () => {
    await service.subscribeAudio([target()]);
    await service.subscribeAudio([target()]);

    // The backfill announces everyone present, so acting on the repeat double-subscribes in Rust.
    expect(engine.subscribe).toHaveBeenCalledTimes(1);
});

/** Three unawaited paths announce one publisher; an in-flight duplicate must not tear the first down. */
it('does not tear down a subscription when one participant is announced twice at once', async () => {
    let settle: () => void = () => {};
    engine.subscribe.mockImplementationOnce(
        () =>
            new Promise<void>(r => {
                settle = r;
            }),
    );

    const first = service.subscribeAudio([target()]);
    await vi.advanceTimersByTimeAsync(0);
    const second = service.subscribeAudio([target()]);
    settle();
    await Promise.all([first, second]);

    expect(engine.subscribe).toHaveBeenCalledTimes(1);
    expect(engine.unsubscribe).not.toHaveBeenCalled();
    expect(service.participantsWithAudio()).toContain('user_a');
});

/** The unsubscribe of the old identity must land before the new one is pulled, never after it. */
it('orders a corrected announcement behind the one it supersedes', async () => {
    let settle: () => void = () => {};
    engine.subscribe.mockImplementationOnce(
        () =>
            new Promise<void>(r => {
                settle = r;
            }),
    );

    const first = service.subscribeAudio([target('user_a', 'sess_1')]);
    await vi.advanceTimersByTimeAsync(0);
    const second = service.subscribeAudio([target('user_a', 'sess_2')]);
    settle();
    await Promise.all([first, second]);

    expect(engine.subscribe).toHaveBeenNthCalledWith(2, SESSION, 'user_a', 'sess_2', 'audio');
    expect(engine.unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(
        engine.subscribe.mock.invocationCallOrder[1],
    );
});

it('resubscribes when the same participant is announced on a new identity', async () => {
    await service.subscribeAudio([target('user_a', 'sess_1')]);
    await service.subscribeAudio([target('user_a', 'sess_2')]);

    expect(engine.unsubscribe).toHaveBeenCalledWith(SESSION, 'user_a');
    expect(engine.subscribe).toHaveBeenNthCalledWith(2, SESSION, 'user_a', 'sess_2', 'audio');
});

it('does not let one slow participant hold up the others announced with them', async () => {
    // A busy channel backfills at once; in sequence one connecting participant delays all the rest.
    engine.subscribe.mockImplementation(async (_session: unknown, id: string) => {
        if (id === 'user_a') throw notFound();
    });

    const done = service.subscribeAudio([target('user_a'), target('user_b')]);
    await vi.advanceTimersByTimeAsync(0);

    expect(service.participantsWithAudio()).toContain('user_b');

    await drainRetries();
    await done;
});

// ── The camera ───────────────────────────────────────────────────────────────

/** The SDK publish puts pixels on the wire; the `publish` declaration puts this client on the roster. */
describe('publishing the camera', () => {
    let publish: MockInstance;
    let unpublish: MockInstance;
    let cameraTrack: {stop: ReturnType<typeof vi.fn>; applyConstraints: ReturnType<typeof vi.fn>};

    beforeEach(() => {
        const guildVoice = TestBed.inject(GuildVoiceService);
        publish = vi.spyOn(guildVoice, 'publish').mockReturnValue(of(publishReply()));
        unpublish = vi.spyOn(guildVoice, 'unpublish').mockReturnValue(of(undefined));

        cameraTrack = {
            stop: vi.fn(),
            applyConstraints: vi.fn(async () => undefined),
        };
        (globalThis as unknown as Record<string, unknown>)['MediaStream'] = class {
            constructor(readonly tracks: unknown[]) {}
        };
        Object.defineProperty(globalThis.navigator, 'mediaDevices', {
            configurable: true,
            value: {getUserMedia: vi.fn(async () => ({getVideoTracks: () => [cameraTrack]}))},
        });
    });

    it('declares the camera only after the room has published it', async () => {
        const name = await service.publishCamera('g1', 'c1');

        expect(name).toBe(CAMERA_TRACK);
        expect(room.publishTrack).toHaveBeenCalledWith(cameraTrack, CAMERA_TRACK);
        expect(publish).toHaveBeenCalledWith('g1', 'c1', {trackNames: [CAMERA_TRACK], video: undefined});
        expect(room.publishTrack.mock.invocationCallOrder[0]).toBeLessThan(
            publish.mock.invocationCallOrder[0],
        );
    });

    /** A clamped publish still worked: nothing rolls back, the capture is re-encoded to the granted rung. */
    it('re-encodes to the granted rung on a clamped publish', async () => {
        publish.mockReturnValue(
            of(
                publishReply({
                    rung: '720p30',
                    height: 720,
                    framerate: 30,
                    degradations: [
                        {
                            key: 'voice.video_ceiling',
                            requested: {kind: 'ladder', rung: '1080p60', rank: 4, ladder: 'video_quality'},
                            granted: {kind: 'ladder', rung: '720p30', rank: 2, ladder: 'video_quality'},
                            reason: 'guild_plan',
                            remedy: 'upgrade_guild',
                            actorCanRemedy: true,
                            subject: {kind: 'guild', id: 'g1'},
                        },
                    ],
                }),
            ),
        );

        const name = await service.publishCamera('g1', 'c1');

        expect(name).toBe(CAMERA_TRACK);
        expect(cameraTrack.applyConstraints).toHaveBeenCalledWith({height: 720, frameRate: 30});
        expect(cameraTrack.stop).not.toHaveBeenCalled();
        expect(TestBed.inject(VoiceLimitsService).notices()).toHaveLength(1);
    });

    /** Nothing was capped, so nothing is re-encoded - the device keeps whatever it opened at. */
    it('leaves an uncapped publish exactly where the device put it', async () => {
        await service.publishCamera('g1', 'c1');

        expect(cameraTrack.applyConstraints).not.toHaveBeenCalled();
    });

    /** A 403 is a refusal no retry gets past, and a running capture leaves the camera light on. */
    it('stops the local track when the publish is refused', async () => {
        publish.mockReturnValue(
            throwError(() => ({
                status: 403,
                error: {
                    key: 'voice.video_ceiling',
                    granted: {kind: 'ladder', rung: 'none', rank: 0, ladder: 'video_quality'},
                },
            })),
        );

        const name = await service.publishCamera('g1', 'c1');

        expect(name).toBeNull();
        expect(cameraTrack.stop).toHaveBeenCalled();
        expect(service.localVideoStream()).toBeNull();
        expect(room.unpublishTrack).toHaveBeenCalledWith(CAMERA_TRACK);
    });

    /** The node enforces this, so opening the device at all would only light it for nobody. */
    it('does not open the camera when the token forbids video', async () => {
        service.canPublishVideo.set(false);

        const name = await service.publishCamera('g1', 'c1');

        expect(name).toBeNull();
        expect(room.publishTrack).not.toHaveBeenCalled();
    });

    it('unpublishes and declares the camera closed', async () => {
        await service.publishCamera('g1', 'c1');

        await service.closeCamera('g1', 'c1');

        expect(room.unpublishTrack).toHaveBeenCalledWith(CAMERA_TRACK);
        expect(unpublish).toHaveBeenCalledWith('g1', 'c1', [CAMERA_TRACK]);
        expect(cameraTrack.stop).toHaveBeenCalled();
    });
});

// ── The screen share ─────────────────────────────────────────────────────────

/** A resolution change retypes the encoder in place; a restart changes the share id and blanks viewers. */
describe('changing resolution mid-share', () => {
    const preset = {resolution: '1440p', framerate: 30, content: 'text'} as const;

    interface Publisher {
        stopScreenPublish: ReturnType<typeof vi.fn>;
        startScreenPublish: ReturnType<typeof vi.fn>;
        setPublishSpec: ReturnType<typeof vi.fn>;
        setPublishFps: ReturnType<typeof vi.fn>;
    }

    let declareVideo: MockInstance;

    function sharing(): Publisher {
        const rustMedia = TestBed.inject(RustMediaService) as unknown as Record<string, unknown>;
        rustMedia['stopScreenPublish'] = vi.fn(async () => undefined);
        rustMedia['startScreenPublish'] = vi.fn();
        rustMedia['setPublishSpec'] = vi.fn(async () => undefined);
        rustMedia['setPublishFps'] = vi.fn(async () => undefined);

        // The state a running publish leaves behind, reached into directly.
        Object.assign(service as unknown as Record<string, unknown>, {
            rustPublishing: true,
            screenShareId: 'live-share',
            screenSourceSize: {width: 1920, height: 1080},
            rustChoice: {
                sourceId: 'monitor:0',
                sourceWidth: 1920,
                sourceHeight: 1080,
                preset: {resolution: '1080p', framerate: 30, content: 'text'},
                shareAudio: false,
            },
        });
        service.screenPreset.set({resolution: '1080p', framerate: 30, content: 'text'});
        return rustMedia as unknown as Publisher;
    }

    beforeEach(() => {
        declareVideo = vi
            .spyOn(TestBed.inject(GuildVoiceService), 'declareVideo')
            .mockReturnValue(of({changed: true, maxLayer: null}));
    });

    it('retypes the running encoder instead of restarting the publish', async () => {
        const rustMedia = sharing();

        await service.setScreenPreset(preset);

        expect(rustMedia.setPublishSpec).toHaveBeenCalled();
        expect(rustMedia.stopScreenPublish).not.toHaveBeenCalled();
        expect(rustMedia.startScreenPublish).not.toHaveBeenCalled();
    });

    it('keeps the share id every viewer is already holding', async () => {
        const rustMedia = sharing();

        await service.setScreenPreset(preset);

        expect((service as unknown as {screenShareId: string}).screenShareId).toBe('live-share');
        expect(rustMedia.startScreenPublish).not.toHaveBeenCalled();
    });

    it('asks for the box and bitrate the new preset solves to', async () => {
        // New geometry with the old bitrate budget would starve the encoder.
        const rustMedia = sharing();

        await service.setScreenPreset(preset);

        const [{width, height, kbps}] = rustMedia.setPublishSpec.mock.calls[0]!;
        expect(width % 2).toBe(0);
        expect(height % 2).toBe(0);
        expect(kbps).toBe(bitrateFor(preset));
    });

    /** The content mode changes no number the encoder is built from, so it needs its own trigger. */
    it('retypes the encoder when only the content mode moves', async () => {
        const rustMedia = sharing();

        await service.setScreenPreset({resolution: '1080p', framerate: 30, content: 'games'});

        expect(rustMedia.setPublishSpec).toHaveBeenCalledTimes(1);
        expect(rustMedia.setPublishSpec.mock.calls[0]![0]).toMatchObject({content: 'games'});
    });

    /** The mode travels with the geometry, so a change to both is still one retype. */
    it('sends the mode alongside the geometry when both move', async () => {
        const rustMedia = sharing();

        await service.setScreenPreset({resolution: '1440p', framerate: 30, content: 'games'});

        expect(rustMedia.setPublishSpec).toHaveBeenCalledTimes(1);
        expect(rustMedia.setPublishSpec.mock.calls[0]![0]).toMatchObject({content: 'games'});
    });

    it('leaves the publish alone when only the framerate moves', async () => {
        const rustMedia = sharing();

        await service.setScreenPreset({resolution: '1080p', framerate: 60, content: 'text'});

        expect(rustMedia.setPublishFps).toHaveBeenCalledWith(60);
        expect(rustMedia.setPublishSpec).not.toHaveBeenCalled();
        expect(rustMedia.stopScreenPublish).not.toHaveBeenCalled();
    });

    it('remembers the new preset for a publish that does restart later', async () => {
        // A restart must open at the resolution the user is watching, not the one they first picked.
        const rustMedia = sharing();

        await service.setScreenPreset(preset);

        const choice = (service as unknown as {rustChoice: {preset: unknown}}).rustChoice;
        expect(choice.preset).toEqual(preset);
        expect(rustMedia.startScreenPublish).not.toHaveBeenCalled();
    });

    /** Declare the solved height, not the preset's nominal one, or the server caps a share inside its rung. */
    it("declares the size it actually solved to, not the preset's nominal one", async () => {
        sharing();
        // An ultrawide fitted into a 1080p box encodes 810 lines.
        Object.assign(service as unknown as Record<string, unknown>, {
            screenSourceSize: {width: 2560, height: 1080},
        });
        service.screenPreset.set({resolution: '720p', framerate: 30, content: 'text'});

        await service.setScreenPreset({resolution: '1080p', framerate: 30, content: 'text'});

        expect(declareVideo).toHaveBeenCalledWith('g1', 'c1', {height: 810, framerate: 30});
    });

    it('declares a framerate change on its own', async () => {
        sharing();

        await service.setScreenPreset({resolution: '1080p', framerate: 60, content: 'text'});

        expect(declareVideo).toHaveBeenCalledWith('g1', 'c1', {height: 1080, framerate: 60});
    });

    /** A change that moves no pixel and no frame declares nothing. */
    it('declares nothing when neither the solved size nor the framerate moved', async () => {
        sharing();

        await service.setScreenPreset({resolution: '1080p', framerate: 30, content: 'games'});

        expect(declareVideo).not.toHaveBeenCalled();
    });
});

/** The publisher owns the capture, encoder and connection; what is left here is the declaration. */
describe('declaring a share', () => {
    let publish: MockInstance;
    let unpublish: MockInstance;

    function publisher(audioTrackName: string | null): Record<string, unknown> {
        const rustMedia = TestBed.inject(RustMediaService) as unknown as Record<string, unknown>;
        rustMedia['startScreenPublish'] = vi.fn(async () => ({encoder: 'mf', audioTrackName}));
        rustMedia['stopScreenPublish'] = vi.fn(async () => undefined);
        return rustMedia;
    }

    beforeEach(() => {
        const guildVoice = TestBed.inject(GuildVoiceService);
        publish = vi.spyOn(guildVoice, 'publish').mockReturnValue(of(publishReply()));
        unpublish = vi.spyOn(guildVoice, 'unpublish').mockReturnValue(of(undefined));
        const picker = TestBed.inject(ScreenPickerService) as unknown as Record<string, unknown>;
        // An ultrawide, so the solved height and the preset's nominal one are different numbers.
        picker['show'] = vi.fn(async () => ({
            sourceId: 'monitor:0',
            sourceWidth: 2560,
            sourceHeight: 1080,
            shareAudio: true,
            preset: {resolution: '1080p', framerate: 30, content: 'text'},
        }));
    });

    it('names both halves of a share that carries audio', async () => {
        publisher('screen-audio');

        const result = await service.publishScreen('g1', 'c1');

        const [, , body] = publish.mock.calls[0]!;
        expect(body.trackNames).toEqual([`screen-${result!.shareId}`, `screen-audio-${result!.shareId}`]);
    });

    /** What was published, not what was asked for: the loopback device can be unavailable. */
    it('names only the video half when no loopback device was opened', async () => {
        publisher(null);

        const result = await service.publishScreen('g1', 'c1');

        const [, , body] = publish.mock.calls[0]!;
        expect(body.trackNames).toEqual([`screen-${result!.shareId}`]);
    });

    /** On the microphone's connection: an identity of its own would be a second roster participant. */
    it('publishes the share on the connection the microphone already holds', async () => {
        const rustMedia = publisher(null);

        await service.publishScreen('g1', 'c1');

        const start = rustMedia['startScreenPublish'] as ReturnType<typeof vi.fn>;
        expect(start.mock.calls[0]![0]).toMatchObject({
            livekit: {url: 'wss://sfu-fsn1.venta.gg', token: 'mic-jwt'},
        });
    });

    it("declares the solved capture height rather than the preset's nominal one", async () => {
        publisher(null);

        await service.publishScreen('g1', 'c1');

        // 2560x1080 fitted into the 1080p box is 1920x810, and 810 is what the encoder is handed.
        const [, , body] = publish.mock.calls[0]!;
        expect(body.video).toEqual({height: 810, framerate: 30});
    });

    /** A refusal the room could not degrade has to stop the media: nobody would receive it. */
    it('stops the publish when the declaration is refused', async () => {
        const rustMedia = publisher(null);
        publish.mockReturnValue(
            throwError(() => ({
                status: 403,
                error: {
                    key: 'voice.video_ceiling',
                    granted: {kind: 'ladder', rung: 'none', rank: 0, ladder: 'video_quality'},
                },
            })),
        );

        const result = await service.publishScreen('g1', 'c1');

        expect(result).toBeNull();
        expect(rustMedia['stopScreenPublish']).toHaveBeenCalled();
        expect(service.screenPreset()).toBeNull();
    });

    it('declares both halves closed when the share stops', async () => {
        publisher('screen-audio');
        const started = await service.publishScreen('g1', 'c1');

        const stopped = await service.closeScreen('g1', 'c1');

        expect(stopped?.shareId).toBe(started!.shareId);
        expect(unpublish).toHaveBeenCalledWith('g1', 'c1', [
            `screen-${started!.shareId}`,
            `screen-audio-${started!.shareId}`,
        ]);
    });
});

/** A publisher-owned share puts no track in this webview, so the browser's own stop must be forwarded. */
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

    /** `RustMediaService` is shared with the 1:1 call path, so this fires for whichever publish ended. */
    it('ignores a publish this service never started', () => {
        (service as unknown as Record<string, unknown>)['rustPublishing'] = false;
        const spy = watchScreenEnded();

        publishEnded.next();

        expect(spy).not.toHaveBeenCalled();
    });
});

// ── Statistics ───────────────────────────────────────────────────────────────

/** The report is answered per track, so the mid that keys `inbound-fps.ts` is read back out of it. */
describe('inbound screen-share fps', () => {
    function inboundRtpVideo(mid: string, framesPerSecond?: number) {
        return {type: 'inbound-rtp', kind: 'video', mid, id: `in-${mid}`, framesPerSecond};
    }

    function sharing(userId: string, shareId: string, stats: Record<string, unknown>[]): void {
        room.hold(
            remoteTrack(userId, `screen-${shareId}`, {
                videoTrack: {
                    getRTCStatsReport: async () => new Map(stats.map((s, i) => [`s${i}`, s])),
                },
            }),
        );
    }

    function poll(): Promise<void> {
        return (service as unknown as {pollStats(): Promise<void>}).pollStats();
    }

    it('reports a remote share fps keyed by user id once a stat carries one', async () => {
        sharing('user_a', 'abc', [inboundRtpVideo('m1', 24)]);

        await poll();

        expect(service.inboundVideoFps()).toEqual({user_a: 24});
    });

    it('gives two concurrent remote shares two independent fps numbers', async () => {
        sharing('user_a', 'abc', [inboundRtpVideo('m1', 30)]);
        sharing('user_b', 'def', [inboundRtpVideo('m2', 12)]);

        await poll();

        expect(service.inboundVideoFps()).toEqual({user_a: 30, user_b: 12});
    });

    it('leaves a share out rather than reporting 0 while its stat has not arrived yet', async () => {
        sharing('user_a', 'abc', [inboundRtpVideo('m1', undefined)]);

        await poll();

        expect(service.inboundVideoFps()).toEqual({});
    });

    /** This is a screen-share readout only; a camera riding the same room is not one. */
    it('ignores a camera track riding the same room', async () => {
        room.hold(
            remoteTrack('user_a', CAMERA_TRACK, {
                videoTrack: {
                    getRTCStatsReport: async () => new Map([['s0', inboundRtpVideo('m1', 30)]]),
                },
            }),
        );

        await poll();

        expect(service.inboundVideoFps()).toEqual({});
    });
});

/** `inboundStatsFor` sees one report, so this service differentiates successive polls into kbps. */
describe('the inspected inbound bitrate', () => {
    /** An inbound stat carrying a cumulative byte counter, as a real report does. */
    function inboundRtpBytes(mid: string, bytesReceived: number) {
        return {type: 'inbound-rtp', kind: 'video', mid, id: `in-${mid}`, bytesReceived};
    }

    function inspect(bytes: number[]): {poll: () => Promise<void>} {
        let index = 0;
        room.hold(
            remoteTrack('user_a', 'screen-abc', {
                videoTrack: {
                    getRTCStatsReport: async () =>
                        new Map([['s0', inboundRtpBytes('m1', bytes[Math.min(index++, bytes.length - 1)])]]),
                },
            }),
        );
        service.inspected.set({shareId: 'share_a', userId: 'user_a'});
        return {poll: () => (service as unknown as {pollStats(): Promise<void>}).pollStats()};
    }

    /** `Date.now` is stubbed rather than the fake timers, which would also rerun the poll under test. */
    const START = 1_700_000_000_000;
    let clock: MockInstance<() => number>;

    beforeEach(() => {
        clock = vi.spyOn(Date, 'now').mockReturnValue(START);
    });

    afterEach(() => clock.mockRestore());

    it('reports no rate on the first poll rather than claiming the stream is silent', async () => {
        const {poll} = inspect([125_000]);

        await poll();

        expect(service.inspectedStats()?.layers[0].kbps).toBeUndefined();
    });

    it('differentiates two successive polls into kbps', async () => {
        const {poll} = inspect([0, 125_000]);

        await poll();
        clock.mockReturnValue(START + 1000);
        await poll();

        // 125000 bytes in one second is 1000 kbps.
        expect(service.inspectedStats()?.layers[0].kbps).toBe(1000);
    });

    /** A reopened panel differentiates against a fresh baseline, not the previous connection's counter. */
    it('forgets its previous sample when polling stops', async () => {
        const {poll} = inspect([0, 125_000]);

        await poll();
        (service as unknown as {stopStatsPolling(): void}).stopStatsPolling();
        service.inspected.set({shareId: 'share_a', userId: 'user_a'});
        clock.mockReturnValue(START + 1000);
        await poll();

        expect(service.inspectedStats()?.layers[0].kbps).toBeUndefined();
    });

    /** An inspection left set pins `armStatsInterval` at its 1s cadence for the rest of the session. */
    it('clears the inspection when polling stops', () => {
        service.inspected.set({shareId: 'share_a', userId: 'user_a'});

        (service as unknown as {stopStatsPolling(): void}).stopStatsPolling();

        expect(service.inspected()).toBeNull();
    });
});

/** A stream's volume is its own gain, independent of its owner's voice. */
describe('stream volume', () => {
    const screenTarget = (userId = 'user_a', mediaSessionId = 'sess_1', trackName = 'screen-audio-abc') => ({
        userId,
        mediaSessionId,
        trackName,
        kind: 'screenAudio' as const,
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

    /** Muting must not zero the stored level: a mute-to-0/unmute-to-1 build only fails on the second unmute. */
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

/** Optional and additive on the wire: the client states it so the server can clamp rather than guess. */
describe('the stated video intent', () => {
    function track(settings: MediaTrackSettings | null): MediaStreamTrack {
        return {getSettings: settings ? () => settings : undefined} as unknown as MediaStreamTrack;
    }

    it('states what the camera actually opened at, not what was asked for', () => {
        expect(trackIntent(track({height: 720, frameRate: 30}))).toEqual({height: 720, framerate: 30});
    });

    /** Cameras report fractional rates; the wire carries whole frames. */
    it('rounds a fractional framerate', () => {
        expect(trackIntent(track({height: 1080, frameRate: 29.97}))).toEqual({height: 1080, framerate: 30});
    });

    /** A clamp the server cannot compute beats one computed from a number this client invented. */
    it('states nothing when the device reports nothing', () => {
        expect(trackIntent(track({height: 720}))).toBeUndefined();
        expect(trackIntent(track({frameRate: 30}))).toBeUndefined();
        expect(trackIntent(track({height: 0, frameRate: 30}))).toBeUndefined();
        expect(trackIntent(track(null))).toBeUndefined();
    });
});

/** A saved preset outlives the room it was chosen in, so clamp before the encoder is built. */
describe('a quality change against a granted rung', () => {
    function sharingAt(rung: string): void {
        const limits = TestBed.inject(VoiceLimitsService);
        limits.enterRoom('g1');
        limits.applySnapshot({
            roomId: 'c1',
            kind: 'channel',
            guildId: 'g1',
            instanceId: 'i1',
            version: 1,
            participants: [],
            limits: {videoCeiling: {kind: 'ladder', rung, rank: 2, ladder: 'video_quality'}},
        });
        service.screenPreset.set({resolution: '720p', framerate: 30, content: 'text'});
    }

    it('clamps a request above the rung down to what it permits', async () => {
        sharingAt('720p30');

        await service.setScreenPreset({resolution: '1080p', framerate: 60, content: 'text'});

        expect(service.screenPreset()).toEqual({resolution: '720p', framerate: 30, content: 'text'});
    });

    it('applies a request the rung reaches unchanged', async () => {
        sharingAt('1080p60');

        await service.setScreenPreset({resolution: '1080p', framerate: 60, content: 'text'});

        expect(service.screenPreset()).toEqual({resolution: '1080p', framerate: 60, content: 'text'});
    });

    /** Negative: no room, no rung, nothing clamped. */
    it('clamps nothing when no room has named a rung', async () => {
        TestBed.inject(VoiceLimitsService).clear();
        service.screenPreset.set({resolution: '720p', framerate: 30, content: 'text'});

        await service.setScreenPreset({resolution: '1440p', framerate: 60, content: 'text'});

        expect(service.screenPreset()).toEqual({resolution: '1440p', framerate: 60, content: 'text'});
    });
});

/** The desktop client sends an empty-string media session id: `??` does not catch it, `||` is required. */
describe('a publisher that announces no media session', () => {
    it('is subscribed to by user id rather than by an empty string', async () => {
        // Module-level fixture; see the beforeEach above.

        await service.subscribeAudio([{userId: 'user_a', mediaSessionId: '', trackName: 'audio'}]);

        expect(engine.subscribe).toHaveBeenCalledWith(SESSION, 'user_a', 'user_a', 'audio');
    });

    it('still prefers a real media session when there is one', async () => {
        // Module-level fixture; see the beforeEach above.

        await service.subscribeAudio([target()]);

        expect(engine.subscribe).toHaveBeenCalledWith(SESSION, 'user_a', 'sess_1', 'audio');
    });

    /** The flip-flop: the same publisher must not read as a new identity on the next announcement. */
    it('does not resubscribe when the same publisher is announced again without a session', async () => {
        // Module-level fixture; see the beforeEach above.

        await service.subscribeAudio([{userId: 'user_a', mediaSessionId: '', trackName: 'audio'}]);
        await service.subscribeAudio([{userId: 'user_a', mediaSessionId: '', trackName: 'audio'}]);

        expect(engine.subscribe).toHaveBeenCalledTimes(1);
        expect(engine.unsubscribe).not.toHaveBeenCalled();
    });
});
