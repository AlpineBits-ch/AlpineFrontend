/**
 * The room wrapper's contract, pinned without an SFU.
 *
 * <p>Nothing here opens a socket, asks for a device or builds an `RTCPeerConnection`: the room is
 * injected through {@link LIVEKIT_ROOM_FACTORY}, so every assertion is about what the service asks
 * the SDK to do rather than about what a server did. That is the only shape in which the two rules
 * this file exists for - `autoSubscribe: false`, and never subscribing audio on a host where Rust
 * owns it - can be tested at all: both are failures of *omission* on the wire, invisible to any test
 * that waits for media to arrive.</p>
 */
import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';
import type {RemoteTrack, Room, RoomConnectOptions, RoomOptions} from 'livekit-client';
import {ConnectionState, RoomEvent, Track, VideoQuality} from 'livekit-client';
import {LIVEKIT_AUDIO_IS_OURS, LIVEKIT_ROOM_FACTORY, LiveKitRoomService} from './livekit-room.service';

/** A publication that records the two calls the service is allowed to make on it. */
class FakePublication {
    readonly subscribeCalls: boolean[] = [];
    readonly qualityCalls: VideoQuality[] = [];

    constructor(
        readonly trackSid: string,
        readonly kind: Track.Kind,
        readonly source: Track.Source,
    ) {}

    setSubscribed(subscribed: boolean): void {
        this.subscribeCalls.push(subscribed);
    }

    setVideoQuality(quality: VideoQuality): void {
        this.qualityCalls.push(quality);
    }
}

/** Enough of `Room` for the service to drive, plus `emit` so a test can play the server's part. */
class FakeRoom {
    readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    readonly remoteParticipants = new Map<
        string,
        {identity: string; trackPublications: Map<string, FakePublication>}
    >();
    connectedWith: {url: string; token: string; opts?: RoomConnectOptions} | null = null;
    disconnectCalls = 0;
    removeAllListenersCalls = 0;

    constructor(readonly options: RoomOptions | undefined) {}

    on(event: string, handler: (...args: unknown[]) => void): this {
        (this.handlers.get(event) ?? this.handlers.set(event, new Set()).get(event)!).add(handler);
        return this;
    }

    off(event: string, handler: (...args: unknown[]) => void): this {
        this.handlers.get(event)?.delete(handler);
        return this;
    }

    removeAllListeners(): this {
        this.removeAllListenersCalls++;
        this.handlers.clear();
        return this;
    }

    connect = async (url: string, token: string, opts?: RoomConnectOptions): Promise<void> => {
        this.connectedWith = {url, token, opts};
    };

    disconnect = async (): Promise<void> => {
        this.disconnectCalls++;
    };

    /** How many handlers are still attached, over every event. */
    get listenerCount(): number {
        return [...this.handlers.values()].reduce((total, set) => total + set.size, 0);
    }

    emit(event: string, ...args: unknown[]): void {
        for (const handler of [...(this.handlers.get(event) ?? [])]) handler(...args);
    }

    /** Registers a publication under a participant, creating the participant if needed. */
    publish(identity: string, publication: FakePublication): FakePublication {
        const participant =
            this.remoteParticipants.get(identity) ??
            this.remoteParticipants.set(identity, {identity, trackPublications: new Map()}).get(identity)!;
        participant.trackPublications.set(publication.trackSid, publication);
        return publication;
    }
}

let rooms: FakeRoom[] = [];
let service: LiveKitRoomService;

/** The room the service is currently driving. */
function room(): FakeRoom {
    expect(rooms.length, 'the service never built a room').toBeGreaterThan(0);
    return rooms[rooms.length - 1];
}

function build(audioIsOurs: boolean): LiveKitRoomService {
    rooms = [];
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            LiveKitRoomService,
            {provide: LIVEKIT_AUDIO_IS_OURS, useValue: audioIsOurs},
            {
                provide: LIVEKIT_ROOM_FACTORY,
                useValue: (options: RoomOptions) => {
                    const fake = new FakeRoom(options);
                    rooms.push(fake);
                    return fake as unknown as Room;
                },
            },
        ],
    });
    return TestBed.inject(LiveKitRoomService);
}

async function connect(): Promise<void> {
    await service.connect({url: 'wss://sfu.example.test', token: 'jwt'});
}

beforeEach(() => {
    service = build(true);
});

describe('connecting', () => {
    /**
     * The single most consequential line in the file. §6.6 gives the server's plan authority over
     * what we pull, and on desktop the Rust room already holds every audio track - a webview that
     * auto-subscribed would play every participant twice and hand the plan nothing to decide.
     */
    it('never lets the server choose our subscriptions for us', async () => {
        await connect();

        expect(room().connectedWith?.opts?.autoSubscribe).toBe(false);
    });

    it('passes the url and token through untouched', async () => {
        await connect();

        expect(room().connectedWith?.url).toBe('wss://sfu.example.test');
        expect(room().connectedWith?.token).toBe('jwt');
    });

    /**
     * **Adaptive stream off is a correctness requirement here, not a tuning choice.**
     *
     * <p>It ties the layer served to the tile's size on screen, and the SDK measures that from
     * elements registered through `RemoteTrack.attach()` - the only thing that fills `elementInfos`.
     * This client never calls it; tiles bind a `MediaStream` to `video.srcObject` instead. So the
     * list is permanently empty and every remote tile is pinned to the smallest rung there is.
     * Measured, one flag changed, same publisher and room: 24 kB/2s at 320px with it on, 400 kB/2s
     * at 1280px with it off.</p>
     *
     * <p>The track keeps flowing either way - an unattached track is starved, not disabled - so the
     * symptom is a soft, smeared tile rather than a black one, and no counter reads as broken.</p>
     *
     * <p>So this asserts `false` deliberately. If the render path ever moves to `track.attach()`,
     * turn it back on and change this line - and not before.</p>
     *
     * <p>`dynacast` stays on: publisher-side, driven by what the server sees subscribers ask for,
     * and needs nothing from our DOM.</p>
     */
    it('builds the room with adaptive stream off, because nothing here attaches tracks', async () => {
        await connect();

        expect(room().options?.adaptiveStream).toBe(false);
        expect(room().options?.dynacast).toBe(true);
    });
});

describe('subscribing', () => {
    function publish(kind: Track.Kind, source: Track.Source, sid = 'TR_1'): FakePublication {
        return room().publish('user-1', new FakePublication(sid, kind, source));
    }

    it('subscribes to a camera', async () => {
        await connect();
        const camera = publish(Track.Kind.Video, Track.Source.Camera);

        expect(service.setSubscribed('TR_1', true)).toBe(true);
        expect(camera.subscribeCalls).toEqual([true]);
    });

    it('subscribes to a screen share', async () => {
        await connect();
        const share = publish(Track.Kind.Video, Track.Source.ScreenShare);

        expect(service.setSubscribed('TR_1', true)).toBe(true);
        expect(share.subscribeCalls).toEqual([true]);
    });

    /**
     * The failure this refusal prevents is double playout, not wasted bandwidth: the Rust room is
     * already pulling this microphone and mixing it, so a second copy plays alongside it, half a
     * jitter buffer out of step, deaf to the per-source volume slider.
     */
    it('refuses a microphone while Rust owns the audio', async () => {
        await connect();
        const mic = publish(Track.Kind.Audio, Track.Source.Microphone);

        expect(service.setSubscribed('TR_1', true)).toBe(false);
        expect(mic.subscribeCalls).toEqual([]);
    });

    /** `screen-audio-*` goes to the same mixer for the same reason. */
    it('refuses screen audio while Rust owns the audio', async () => {
        await connect();
        const shareAudio = publish(Track.Kind.Audio, Track.Source.ScreenShareAudio);

        expect(service.setSubscribed('TR_1', true)).toBe(false);
        expect(shareAudio.subscribeCalls).toEqual([]);
    });

    /** Silent refusals are how a room goes quiet with nothing to look at afterwards. */
    it('counts every refusal', async () => {
        await connect();
        publish(Track.Kind.Audio, Track.Source.Microphone, 'TR_1');
        publish(Track.Kind.Audio, Track.Source.ScreenShareAudio, 'TR_2');

        service.setSubscribed('TR_1', true);
        service.setSubscribed('TR_2', true);

        expect(service.refusedAudioSubscriptions()).toBe(2);
    });

    /** The browser build has no Rust room to collide with, so the same call is the right one. */
    it('subscribes to audio when this room is the only one', async () => {
        service = build(false);
        await connect();
        const mic = publish(Track.Kind.Audio, Track.Source.Microphone);

        expect(service.setSubscribed('TR_1', true)).toBe(true);
        expect(mic.subscribeCalls).toEqual([true]);
        expect(service.refusedAudioSubscriptions()).toBe(0);
    });

    /**
     * Dropping is never the double-playout risk, and refusing it would strand a subscription we did
     * somehow acquire - through a reconnect that restored more than we asked for, say.
     */
    it('lets an audio track be dropped even where subscribing to one is refused', async () => {
        await connect();
        const mic = publish(Track.Kind.Audio, Track.Source.Microphone);

        expect(service.setSubscribed('TR_1', false)).toBe(true);
        expect(mic.subscribeCalls).toEqual([false]);
    });

    /**
     * A plan can name a track this room has not been told about yet. Answering false lets the caller
     * hold it for the next diff rather than treating a race as an error.
     */
    it('answers false for a track sid the room does not know', async () => {
        await connect();

        expect(service.setSubscribed('TR_missing', true)).toBe(false);
    });
});

/**
 * The twin of `src-tauri/src/media/livekit/identity.rs::user_of`, and it must stay a twin: the two
 * ends split the same strings, and a client that disagreed would attribute a participant to nobody.
 */
describe('the user behind an identity', () => {
    it('reads a secondary connection as its owner', () => {
        expect(service.userOf('user-1#view')).toBe('user-1');
    });

    /** Sqids are alphanumeric and never contain `#` - which is the whole basis for splitting on it. */
    it('leaves a primary identity alone', () => {
        for (const id of ['Uk1sRT', 'bM2cD9xQ', '1']) expect(service.userOf(id)).toBe(id);
    });

    /**
     * The server strips `#` out of a tag, so a second one should be impossible - but splitting on the
     * last would name `user-1#view`, which is not a user anybody has.
     */
    it('splits at the first hash, not the last', () => {
        expect(service.userOf('user-1#view#extra')).toBe('user-1');
    });
});

describe('the layer a subscription asks for', () => {
    let camera: FakePublication;

    beforeEach(async () => {
        await connect();
        camera = room().publish('user-1', new FakePublication('TR_1', Track.Kind.Video, Track.Source.Camera));
    });

    /** `a` is the top rung, not the first rid. The server ranks; it never sees a rid. */
    it('maps the server ranking onto a quality', () => {
        expect(service.setLayer('TR_1', 'a')).toBe(true);
        expect(service.setLayer('TR_1', 'b')).toBe(true);
        expect(service.setLayer('TR_1', 'c')).toBe(true);

        expect(camera.qualityCalls).toEqual([VideoQuality.HIGH, VideoQuality.MEDIUM, VideoQuality.LOW]);
    });

    /**
     * `f`/`h`/`q` are the rids we *publish* under. They travel in the opposite direction and mean
     * nothing here; accepting one would cap a viewer at whatever position it happened to hash to.
     */
    it('does not mistake a publish rid for a ranking', () => {
        for (const rid of ['f', 'h', 'q']) expect(service.setLayer('TR_1', rid)).toBe(false);

        expect(camera.qualityCalls).toEqual([]);
    });

    /**
     * §6.1: the letters were kept rather than renamed to high/medium/low precisely because an
     * unrecognised spelling already falls back to the server's choice. Guessing at one would pin a
     * viewer to a rung the server did not pick, and adaptive stream would stop moving them off it.
     */
    it('leaves the server in charge of an unrecognised spelling', () => {
        for (const layer of ['d', 'A', 'high', '', 'medium'])
            expect(service.setLayer('TR_1', layer)).toBe(false);

        expect(camera.qualityCalls).toEqual([]);
    });

    /** `layer: null` is the ordinary uncapped case, and every audio entry carries it. */
    it('leaves the server in charge when no layer is named', () => {
        expect(service.setLayer('TR_1', null)).toBe(false);

        expect(camera.qualityCalls).toEqual([]);
    });

    /** Separated from an unrecognised spelling: this one is a race, not a contract disagreement. */
    it('counts an unrecognised spelling but not an absent one', () => {
        service.setLayer('TR_1', 'd');
        service.setLayer('TR_1', null);

        expect(service.unrecognisedLayers()).toBe(1);
    });

    it('answers false for a track sid the room does not know', () => {
        expect(service.setLayer('TR_missing', 'a')).toBe(false);
    });
});

describe('what the room is holding', () => {
    /** Plays the server's part: a track arriving on a participant the room already knows. */
    function subscribe(identity: string, publication: FakePublication): void {
        room().publish(identity, publication);
        room().emit(
            RoomEvent.TrackSubscribed,
            {} as RemoteTrack,
            publication,
            room().remoteParticipants.get(identity),
        );
    }

    const CAMERA = (): FakePublication => new FakePublication('TR_1', Track.Kind.Video, Track.Source.Camera);

    /**
     * The webview connects as `{userId}#view`, so its own tracks come back under a decorated identity
     * too. Everything above this service is keyed by user id and would not match one.
     */
    it('files a track under the user, not the identity that published it', async () => {
        await connect();

        subscribe('user-1#view', CAMERA());

        expect(service.remoteTracks().get('TR_1')?.userId).toBe('user-1');
        expect(service.remoteTracks().get('TR_1')?.identity).toBe('user-1#view');
    });

    it('forgets a track once it is unsubscribed', async () => {
        await connect();
        const camera = CAMERA();
        subscribe('user-1', camera);

        room().emit(
            RoomEvent.TrackUnsubscribed,
            {} as RemoteTrack,
            camera,
            room().remoteParticipants.get('user-1'),
        );

        expect(service.remoteTracks().size).toBe(0);
    });

    it('follows the connection state', async () => {
        await connect();

        room().emit(RoomEvent.ConnectionStateChanged, ConnectionState.Reconnecting);

        expect(service.state()).toBe(ConnectionState.Reconnecting);
    });
});

describe('disconnecting', () => {
    it('hands the room back and drops it', async () => {
        await connect();
        const first = room();

        await service.disconnect();

        expect(first.disconnectCalls).toBe(1);
        expect(service.state()).toBe(ConnectionState.Disconnected);
    });

    /**
     * A handler left on a discarded room keeps the room, its participants and their tracks reachable,
     * and - worse - keeps writing into signals a later connection is also writing into.
     */
    it('leaves no listener attached', async () => {
        await connect();
        const first = room();
        expect(first.listenerCount, 'the service registered no listeners to clean up').toBeGreaterThan(0);

        await service.disconnect();

        expect(first.listenerCount).toBe(0);
    });

    it('forgets the tracks the old room was holding', async () => {
        await connect();
        const camera = new FakePublication('TR_1', Track.Kind.Video, Track.Source.Camera);
        room().publish('user-1', camera);
        room().emit(
            RoomEvent.TrackSubscribed,
            {} as RemoteTrack,
            camera,
            room().remoteParticipants.get('user-1'),
        );

        await service.disconnect();

        expect(service.remoteTracks().size).toBe(0);
    });

    /** No room means no publication to find - the caller gets the same "not here" it gets in a race. */
    it('answers false to anything asked of it afterwards', async () => {
        await connect();
        room().publish('user-1', new FakePublication('TR_1', Track.Kind.Video, Track.Source.Camera));

        await service.disconnect();

        expect(service.setSubscribed('TR_1', true)).toBe(false);
        expect(service.setLayer('TR_1', 'a')).toBe(false);
    });

    it('builds a fresh room on the next connect', async () => {
        await connect();
        await service.disconnect();

        await connect();

        expect(rooms.length).toBe(2);
        expect(room().connectedWith?.opts?.autoSubscribe).toBe(false);
    });

    /** Called from a teardown that cannot know whether the connect ever landed. */
    it('is a no-op when there was never a room', async () => {
        await expect(service.disconnect()).resolves.toBeUndefined();
    });
});
