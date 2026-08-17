/**
 * The browser publish path, driven end to end through the adapter.
 *
 * <p>Every assertion here is on something that <b>crossed a stage boundary</b> - the constraints the
 * browser was actually asked for, the body the SFU was actually sent, the tracks that were actually
 * stopped - rather than on the arguments that went in. A media test that checks the inputs it was handed
 * passes while proving nothing; see `project_media_e2e_test_traps`.</p>
 *
 * <p>jsdom has no WebRTC, no `MediaStream` and no `mediaDevices`, so the harness below defines them. They
 * are the seams: nothing is mocked out of the adapter itself.</p>
 */
import {DEFAULT_STREAM_PRESET, StreamPreset} from '../../models/stream-preset';
import {publishOptions} from '../../services/screen-publish';
import {ScreenPublishOptions} from '../ports/screen-publisher.port';
import {TauriScreenPublisher} from '../tauri/screen-publisher.tauri';
import {WebScreenPublisher} from './screen-publisher.web';

// â”€â”€ Fakes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * A track the adapter can drive: `stop`, `applyConstraints`, `enabled`, `contentHint`, `onended`.
 *
 * <p>Structural rather than `implements MediaStreamTrack` - the real interface is 30 members wide and
 * nothing here needs the other 25.</p>
 */
interface FakeTrack {
    kind: 'video' | 'audio';
    id: string;
    enabled: boolean;
    readyState: string;
    contentHint: string;
    onended: ((event: Event) => void) | null;
    stop: ReturnType<typeof vi.fn>;
    applyConstraints: ReturnType<typeof vi.fn>;
}

function fakeTrack(kind: 'video' | 'audio'): FakeTrack {
    const track: FakeTrack = {
        kind,
        id: `${kind}-track`,
        enabled: true,
        readyState: 'live',
        contentHint: '',
        onended: null,
        stop: vi.fn(() => {
            track.readyState = 'ended';
        }),
        applyConstraints: vi.fn(async () => {}),
    };
    return track;
}

class FakeMediaStream {
    private readonly tracks: FakeTrack[];

    constructor(tracks: unknown[] = []) {
        this.tracks = [...tracks] as FakeTrack[];
    }

    getTracks(): MediaStreamTrack[] {
        return [...this.tracks] as unknown as MediaStreamTrack[];
    }

    getVideoTracks(): MediaStreamTrack[] {
        return this.tracks.filter(t => t.kind === 'video') as unknown as MediaStreamTrack[];
    }

    getAudioTracks(): MediaStreamTrack[] {
        return this.tracks.filter(t => t.kind === 'audio') as unknown as MediaStreamTrack[];
    }
}

/** Enough of an offer for `withStartBitrate` to have something to munge. */
const OFFER_SDP = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP9/90000', ''].join('\r\n');

class FakeSender {
    params: RTCRtpSendParameters = {encodings: [{}]} as RTCRtpSendParameters;

    constructor(readonly track: FakeTrack) {}

    getParameters(): RTCRtpSendParameters {
        return this.params;
    }

    async setParameters(params: RTCRtpSendParameters): Promise<void> {
        this.params = params;
    }
}

class FakePeerConnection {
    static instances: FakePeerConnection[] = [];
    localDescription: RTCSessionDescriptionInit | null = null;
    remoteDescription: RTCSessionDescriptionInit | null = null;
    closed = false;
    readonly senders: FakeSender[] = [];
    readonly codecPreferences: unknown[][] = [];

    constructor(readonly config: RTCConfiguration) {
        FakePeerConnection.instances.push(this);
    }

    addTrack(track: FakeTrack): FakeSender {
        const sender = new FakeSender(track);
        this.senders.push(sender);
        return sender;
    }

    /**
     * How the video half is published now, because `sendEncodings` is only honoured when the
     * transceiver is created. The ladder is copied onto the sender's parameters so a test can read
     * back the rids the way a real sender would report them.
     */
    addTransceiver(track: FakeTrack, init?: RTCRtpTransceiverInit) {
        const sender = new FakeSender(track);
        sender.params = {encodings: (init?.sendEncodings ?? [{}]).map(e => ({...e}))} as RTCRtpSendParameters;
        this.senders.push(sender);
        return {
            sender,
            mid: String(this.senders.length - 1),
            setCodecPreferences: (codecs: unknown[]) => this.codecPreferences.push(codecs),
        };
    }

    getTransceivers(): {sender: FakeSender; mid: string; setCodecPreferences: (c: unknown[]) => void}[] {
        return this.senders.map((sender, index) => ({
            sender,
            mid: String(index),
            setCodecPreferences: (codecs: unknown[]) => this.codecPreferences.push(codecs),
        }));
    }

    async createOffer(): Promise<RTCSessionDescriptionInit> {
        return {type: 'offer', sdp: OFFER_SDP};
    }

    async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
        this.localDescription = description;
    }

    async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
        this.remoteDescription = description;
    }

    close(): void {
        this.closed = true;
    }
}

interface Posted {
    method: string;
    url: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
}

let posted: Posted[] = [];
let displayCalls: MediaStreamConstraints[] = [];
let displayResult: (constraints: MediaStreamConstraints) => Promise<FakeMediaStream>;
let restore: (() => void)[] = [];

function define(target: object, key: string, value: unknown): void {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, {value, configurable: true, writable: true});
    restore.push(() => {
        if (original) Object.defineProperty(target, key, original);
        else delete (target as Record<string, unknown>)[key];
    });
}

/** The SFU's answer: echoes back whatever was asked for, unless a test overrides it. */
function negotiateResponse(body: Record<string, unknown>): unknown {
    const tracks = (body['tracks'] as {trackName: string; mid: string}[] | undefined) ?? [];
    return {
        sessionDescription: {type: 'answer', sdp: 'answer-sdp'},
        tracks: tracks.map(t => ({mid: t.mid, trackName: t.trackName})),
        requiresImmediateRenegotiation: false,
    };
}

let respond: (url: string, body: Record<string, unknown>) => unknown = (url, body) =>
    url.endsWith('/session?primary=false') ? {mediaSessionId: 'cf-session-1'} : negotiateResponse(body);

beforeEach(() => {
    posted = [];
    displayCalls = [];
    restore = [];
    FakePeerConnection.instances = [];
    displayResult = async () => new FakeMediaStream([fakeTrack('video'), fakeTrack('audio')]);
    respond = (url, body) =>
        url.endsWith('/session?primary=false') ? {mediaSessionId: 'cf-session-1'} : negotiateResponse(body);

    define(globalThis, 'MediaStream', FakeMediaStream);
    define(globalThis, 'RTCPeerConnection', FakePeerConnection);
    define(globalThis, 'RTCRtpSender', {
        getCapabilities: () => ({codecs: [{mimeType: 'video/VP8'}, {mimeType: 'video/VP9'}]}),
    });
    define(navigator, 'mediaDevices', {
        getDisplayMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
            displayCalls.push(constraints);
            return displayResult(constraints);
        }),
    });
    define(
        globalThis,
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>;
            posted.push({
                method: String(init.method),
                url,
                body,
                headers: init.headers as Record<string, string>,
            });
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify(respond(url, body)),
            } as Response;
        }),
    );
});

afterEach(() => {
    restore.forEach(fn => fn());
    vi.restoreAllMocks();
});

function options(over: Partial<ScreenPublishOptions> = {}): ScreenPublishOptions {
    return {
        sourceId: '',
        shareId: 'abc',
        width: 1920,
        height: 1080,
        fps: 30,
        kbps: 4500,
        content: 'text',
        iceServers: [{urls: ['stun:stun.test:3478']}],
        livekit: {url: 'wss://sfu.test', token: 'lk-tok'},
        apiBase: 'https://api.test/',
        token: 'tok',
        deviceId: 'dev-1',
        guildId: 'guild-1',
        channelId: 'chan-1',
        shareAudio: true,
        preset: DEFAULT_STREAM_PRESET,
        ...over,
    };
}

function publishBody(): Record<string, unknown> {
    const call = posted.filter(p => p.url.endsWith('/tracks')).at(-1);
    expect(call, 'the publish was never sent').toBeDefined();
    return call!.body;
}

function publishedTracks(): {direction: string; mid: string; trackName: string}[] {
    return publishBody()['tracks'] as {direction: string; mid: string; trackName: string}[];
}

// â”€â”€ Tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('WebScreenPublisher: what it publishes', () => {
    it('publishes both halves in one negotiation and answers with what was published', async () => {
        const result = await new WebScreenPublisher().start(options({shareId: 'xyz'}));

        expect(publishedTracks()).toEqual([
            {direction: 'publish', mid: '0', trackName: 'screen-xyz'},
            {direction: 'publish', mid: '1', trackName: 'screen-audio-xyz'},
        ]);
        expect(result).toMatchObject({
            mediaSessionId: 'cf-session-1',
            trackName: 'screen-xyz',
            audioTrackName: 'screen-audio-xyz',
        });
    });

    /**
     * Secondary, always. The primary session is the one the backend records as carrying this
     * participant's voice; a screen share claiming it hands peers a session with no audio track.
     */
    it('opens its own secondary media session, stamped with the device id', async () => {
        await new WebScreenPublisher().start(options());

        const session = posted[0];
        expect(session.url).toBe(
            'https://api.test/api/v1/guild/guilds/guild-1/channels/chan-1/voice/session?primary=false',
        );
        expect(session.headers['X-Device-Id']).toBe('dev-1');
        expect(session.headers['Authorization']).toBe('Bearer tok');
    });

    /** The DM route needs its `messaging/` segment or it 404s at the gateway rather than the service. */
    it('publishes a DM call on the messaging route', async () => {
        await new WebScreenPublisher().start(
            options({guildId: undefined, channelId: undefined, callId: 'call-9'}),
        );

        expect(posted[0].url).toBe(
            'https://api.test/api/v1/messaging/voice/calls/call-9/session?primary=false',
        );
    });

    /** The ramp fix: without a start bitrate the first half-minute of every share is mush. */
    it('offers with the preset bitrate munged into the SDP', async () => {
        await new WebScreenPublisher().start(options({kbps: 8000}));

        const offer = publishBody()['sessionDescription'] as RTCSessionDescriptionInit;
        expect(offer.sdp).toContain('x-google-start-bitrate=8000');
    });

    /**
     * The declaration the server computes its fan-out cap from. It is the solved capture height, not
     * the preset's nominal one: `publishOptions` has already fitted the source into the preset's box,
     * so an ultrawide at 1080p genuinely encodes 540 lines and claiming 1080 would have the server
     * cap a share that is well inside its rung.
     */
    it('declares the size it is about to encode', async () => {
        await new WebScreenPublisher().start(options({width: 1920, height: 540, fps: 30}));

        expect(publishBody()['video']).toEqual({height: 540, framerate: 30});
    });

    /** Negative: an unmeasured source. The field is omitted rather than filled with a guess. */
    it('declares nothing when the geometry is unstated', async () => {
        await new WebScreenPublisher().start(options({height: 0}));

        expect('video' in publishBody()).toBe(false);
    });

    it('caps the sender at the preset it was given', async () => {
        const preset: StreamPreset = {resolution: '720p', framerate: 15, content: 'text'};

        await new WebScreenPublisher().start(options({fps: 15, kbps: 1500, preset}));

        const video = FakePeerConnection.instances[0].senders[0];
        expect(video.params.encodings?.[0].maxBitrate).toBe(1_500_000);
        expect(video.params.encodings?.[0].maxFramerate).toBe(15);
        expect(video.params.degradationPreference).toBe('maintain-resolution');
        expect(video.track.contentHint).toBe('detail');
    });

    /**
     * The same publish in the other mode, end to end through the adapter rather than against
     * `applyScreenEncoding` directly: the capture hint and the sender policy are set in two
     * different places, and this is what catches one of them being left pinned to text.
     */
    it('publishes a games share as motion, holding framerate instead of resolution', async () => {
        const preset: StreamPreset = {resolution: '1080p', framerate: 60, content: 'games'};

        await new WebScreenPublisher().start(options({fps: 60, kbps: 8000, preset, content: 'games'}));

        const video = FakePeerConnection.instances[0].senders[0];
        expect(video.params.degradationPreference).toBe('maintain-framerate');
        expect(video.track.contentHint).toBe('motion');
    });
});

describe('WebScreenPublisher: audio that was asked for and did not arrive', () => {
    /**
     * The failure this exists to prevent: a share that quietly drops the audio the user ticked. Screen
     * audio is Chromium-only and tab/window-scoped, so this is the common case, not the edge one.
     */
    it('proceeds video-only, publishes no audio track, and says so', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        displayResult = async () => new FakeMediaStream([fakeTrack('video')]);

        const result = await new WebScreenPublisher().start(options({shareAudio: true}));

        expect(result.audioTrackName).toBeNull();
        expect(publishedTracks().map(t => t.trackName)).toEqual(['screen-abc']);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('audio was requested but this host published none'),
        );
    });

    /**
     * Firefox and Safari treat `audio: true` on display capture as unsupported rather than as
     * unavailable, and reject the whole call. A video-only share beats no share.
     */
    it('retries video-only when the host refuses the audio constraint', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        let attempt = 0;
        displayResult = async () => {
            if (attempt++ === 0) throw new TypeError('audio is not supported');
            return new FakeMediaStream([fakeTrack('video')]);
        };

        const result = await new WebScreenPublisher().start(options({shareAudio: true}));

        expect(displayCalls.map(c => c.audio)).toEqual([true, false]);
        expect(result.audioTrackName).toBeNull();
    });

    /** A cancelled picker must not be reopened: retrying reads as the app refusing to take no. */
    it('does not reopen the picker when the user cancelled', async () => {
        displayResult = async () => {
            throw Object.assign(new Error('Permission denied'), {name: 'NotAllowedError'});
        };

        await expect(new WebScreenPublisher().start(options())).rejects.toThrow(/Permission denied/);

        expect(displayCalls).toHaveLength(1);
        expect(posted).toEqual([]);
    });

    /** The SFU can refuse the audio half on its own; the video share still stands, without it. */
    it('reports no audio when the SFU refuses that track alone', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        respond = (url, body) => {
            if (url.endsWith('/session?primary=false')) return {mediaSessionId: 'cf-session-1'};
            const tracks = body['tracks'] as {trackName: string; mid: string}[];
            return {
                sessionDescription: {type: 'answer', sdp: 'answer-sdp'},
                tracks: tracks.map(t =>
                    t.trackName.startsWith('screen-audio-')
                        ? {...t, errorCode: 'audio_rejected', errorDescription: 'nope'}
                        : t,
                ),
                requiresImmediateRenegotiation: false,
            };
        };

        const result = await new WebScreenPublisher().start(options());

        expect(result.trackName).toBe('screen-abc');
        expect(result.audioTrackName).toBeNull();
    });

    /** Nothing half-open: a failed publish must not leave the capture indicator up over nothing. */
    it('stops the capture when the publish fails', async () => {
        const video = fakeTrack('video');
        displayResult = async () => new FakeMediaStream([video]);
        respond = () => {
            throw new Error('unused');
        };
        vi.mocked(globalThis.fetch).mockRejectedValue(new Error('502 session_error'));

        await expect(new WebScreenPublisher().start(options())).rejects.toThrow(/502/);

        expect(video.stop).toHaveBeenCalled();
    });
});

describe('WebScreenPublisher: share ids', () => {
    it('closes both published tracks and the capture when its own share is stopped', async () => {
        const video = fakeTrack('video');
        const audio = fakeTrack('audio');
        displayResult = async () => new FakeMediaStream([video, audio]);
        const adapter = new WebScreenPublisher();
        await adapter.start(options({shareId: 'live'}));

        await adapter.stop('live');

        const close = posted.find(p => p.url.endsWith('/tracks/close'));
        expect(close?.body).toMatchObject({
            mediaSessionId: 'cf-session-1',
            trackNames: ['screen-live', 'screen-audio-live'],
        });
        expect(video.stop).toHaveBeenCalled();
        expect(audio.stop).toHaveBeenCalled();
        expect(FakePeerConnection.instances[0].closed).toBe(true);
    });

    it('refuses to stop a live share on behalf of a stale id', async () => {
        const video = fakeTrack('video');
        displayResult = async () => new FakeMediaStream([video]);
        const adapter = new WebScreenPublisher();
        await adapter.start(options({shareId: 'live'}));

        await expect(adapter.stop('replaced')).rejects.toThrow(/refused/);

        expect(posted.some(p => p.url.endsWith('/tracks/close'))).toBe(false);
        expect(video.stop).not.toHaveBeenCalled();
        expect(FakePeerConnection.instances[0].closed).toBe(false);
    });

    it('refuses a framerate change and an audio mute aimed at a stale id', async () => {
        const video = fakeTrack('video');
        const audio = fakeTrack('audio');
        displayResult = async () => new FakeMediaStream([video, audio]);
        const adapter = new WebScreenPublisher();
        await adapter.start(options({shareId: 'live'}));

        await expect(adapter.setFps('replaced', 15)).rejects.toThrow(/refused/);
        await expect(adapter.setAudioMuted('replaced', true)).rejects.toThrow(/refused/);

        expect(video.applyConstraints).not.toHaveBeenCalled();
        expect(audio.enabled).toBe(true);
    });

    /** Both halves of a framerate change: the capture rate, and the cap on what is sent. */
    it('retargets capture and encoding together on its own share', async () => {
        const video = fakeTrack('video');
        displayResult = async () => new FakeMediaStream([video]);
        const adapter = new WebScreenPublisher();
        await adapter.start(options({shareId: 'live', fps: 30}));

        await adapter.setFps('live', 15);

        expect(video.applyConstraints).toHaveBeenCalledWith({frameRate: {ideal: 15, max: 15}});
        expect(FakePeerConnection.instances[0].senders[0].params.encodings?.[0].maxFramerate).toBe(15);
    });

    /**
     * A resolution change is an `applyConstraints` and a `setParameters`, and neither is an SDP
     * event - so no request leaves this client and the server's recorded size goes stale. Pinned
     * because the fix for that has to be a re-declare the server can hear, and a test asserting the
     * silence is what says which fix is needed.
     */
    it('changes resolution without signalling anything', async () => {
        const video = fakeTrack('video');
        displayResult = async () => new FakeMediaStream([video]);
        const adapter = new WebScreenPublisher();
        await adapter.start(options({shareId: 'live', width: 1920, height: 1080}));
        const before = posted.length;

        await adapter.setSpec('live', {width: 1280, height: 720, kbps: 2500, content: 'text'});

        expect(video.applyConstraints).toHaveBeenCalledWith({width: {max: 1280}, height: {max: 720}});
        expect(FakePeerConnection.instances[0].senders[0].params.encodings?.[0].maxBitrate).toBe(2_500_000);
        expect(posted.length).toBe(before);
    });

    it('mutes the share audio without stopping the capture device', async () => {
        const audio = fakeTrack('audio');
        displayResult = async () => new FakeMediaStream([fakeTrack('video'), audio]);
        const adapter = new WebScreenPublisher();
        await adapter.start(options({shareId: 'live'}));

        await adapter.setAudioMuted('live', true);

        expect(audio.enabled).toBe(false);
        expect(audio.stop).not.toHaveBeenCalled();
    });

    /** A resolution change is stop-then-start, and only the new id works afterwards. */
    it('follows the share id across a restart', async () => {
        const adapter = new WebScreenPublisher();
        await adapter.start(options({shareId: 'first'}));
        await adapter.stop('first');
        await adapter.start(options({shareId: 'second'}));

        await expect(adapter.setFps('first', 15)).rejects.toThrow(/refused/);
        await adapter.setFps('second', 15);
    });
});

describe('WebScreenPublisher: the host owns the picker', () => {
    it('reports no in-app picker and enumerates nothing', async () => {
        const adapter = new WebScreenPublisher();

        expect(adapter.hasSourcePicker).toBe(false);
        // Not one fabricated "your screen" entry: an id that start() could not honour is worse than none.
        expect(await adapter.sources()).toEqual([]);
        expect(await adapter.thumbnails(['anything'])).toEqual([]);
    });

    it('has no native capture pipeline to offer', async () => {
        const adapter = new WebScreenPublisher();

        expect(adapter.nativeCapture).toBe(false);
        await expect(adapter.startNativeScreenCapture()).rejects.toThrow(/no native screen capture/);
        await expect(adapter.startNativeLoopbackCapture()).rejects.toThrow(/no loopback capture/);
        expect(await adapter.prefersNativeAudioCapture()).toBe(false);
    });

    /**
     * The browser's capture bar is how a web user ends a share, and it does not go through the app.
     * The publish has to come down with it, or viewers sit on a frozen frame forever.
     */
    it('tears the publish down when the host ends the capture', async () => {
        const video = fakeTrack('video');
        displayResult = async () => new FakeMediaStream([video]);
        const adapter = new WebScreenPublisher();
        const ended = vi.fn();
        adapter.onPublishEnded(ended);
        await adapter.start(options({shareId: 'live'}));

        video.onended?.(new Event('ended'));
        await vi.waitFor(() => expect(ended).toHaveBeenCalled());

        expect(posted.some(p => p.url.endsWith('/tracks/close'))).toBe(true);
        expect(FakePeerConnection.instances[0].closed).toBe(true);
    });
});

/**
 * The one thing both hosts must agree on.
 *
 * <p>A preset is turned into pixels exactly once, in `publishOptions`, and both adapters consume the
 * result without re-deriving it. If either of them solved geometry itself, "1080p at 30" would quietly
 * mean two different things depending on where the app was running - and the desktop and web sides of one
 * call would encode at different sizes for the same setting.</p>
 */
describe('geometry parity between the two adapters', () => {
    const choice = {
        sourceId: 'monitor:0',
        sourceWidth: 3840,
        sourceHeight: 2160,
        preset: {resolution: '1080p', framerate: 60, content: 'text'} as StreamPreset,
        shareAudio: false,
    };

    function solved(): ScreenPublishOptions {
        return publishOptions(
            choice,
            'share-1',
            'https://api.test',
            'tok',
            'dev-1',
            {guildId: 'g', channelId: 'c'},
            null,
            {url: 'wss://sfu.test', token: 'lk-tok'},
        );
    }

    it('asks the browser for exactly the geometry the solver produced', async () => {
        const o = solved();

        await new WebScreenPublisher().start(o);

        expect(o).toMatchObject({width: 1920, height: 1080, fps: 60, kbps: 8000});
        expect(displayCalls[0].video).toEqual({
            // A cap, not a target: the solver never upscales, and asking for an exact size would have
            // the host stretch a small window up to it.
            width: {max: o.width},
            height: {max: o.height},
            frameRate: {ideal: o.fps, max: o.fps},
        });
    });

    it('hands the native encoder the same numbers', async () => {
        const o = solved();
        const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
            void args;
            return {
                mediaSessionId: 'cf-1',
                trackName: 'screen-share-1',
                audioTrackName: null,
                encoder: 'openh264',
            };
        });
        const tauri = new TauriScreenPublisher(
            async () =>
                ({
                    invoke,
                    Channel: class {
                        onmessage: unknown = null;
                    },
                }) as never,
        );

        await tauri.start(o);
        await new WebScreenPublisher().start(o);

        const native = invoke.mock.calls[0][1] ?? {};
        const browser = displayCalls[0].video as MediaTrackConstraints;
        expect(native['width']).toBe((browser.width as ConstrainULongRange).max);
        expect(native['height']).toBe((browser.height as ConstrainULongRange).max);
        expect(native['fps']).toBe((browser.frameRate as ConstrainDoubleRange).max);
    });
});
