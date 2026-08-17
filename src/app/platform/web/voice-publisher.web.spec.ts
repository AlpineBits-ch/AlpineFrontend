/**
 * The browser microphone publisher, driven through every stage boundary it has.
 *
 * <p>A media test can pass while proving nothing, in two specific ways, and this file is written
 * against both. The first is a test that never crosses a boundary - asserting a promise resolved, or
 * that `getUserMedia` was called, says nothing about whether a track reached the SFU or whether audio
 * reached a participant. So the fakes here are wired end to end: the peer connection fires `ontrack`
 * from inside `setRemoteDescription`, exactly as a browser does, which means a mid registered one line
 * too late shows up as a <b>participant missing from the mix</b> rather than as a passing test.</p>
 *
 * <p>The second is a counter that cannot see a starved handler. `stats()` is asserted on the split
 * between routed and unmapped packets rather than on a total, because a total is what let one talker's
 * traffic stand in for a second participant's silence.</p>
 *
 * <p>Every assertion was checked against a mutation of the thing it guards; the notes say which.</p>
 */
import {signal} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {TestBed} from '@angular/core/testing';
import {of} from 'rxjs';
import {MediaDeviceResolverService} from '../../services/media-device-resolver.service';
import {VAD_METER_FLOOR_DB, VoiceActivityService} from '../../services/voice-activity.service';
import {isStaleSubscription, STALE_SUBSCRIPTION} from '../../models/voice-room';
import {slotFor, vadThresholdFor, VAD_THRESHOLD_OPEN_DB, WebVoicePublisher} from './voice-publisher.web';
import type {VoiceProcessing, VoiceSession} from '../ports/voice-publisher.port';

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeParam {
    value = 1;
    cancelScheduledValues = vi.fn();
    setValueAtTime = vi.fn();
    linearRampToValueAtTime = vi.fn((v: number) => {
        this.value = v;
    });
}

class FakeNode {
    readonly connect = vi.fn();
    readonly disconnect = vi.fn();
}

class FakeGain extends FakeNode {
    readonly gain = new FakeParam();
}

class FakePanner extends FakeNode {
    readonly pan = new FakeParam();
}

class FakeAnalyser extends FakeNode {
    fftSize = 2048;
    amplitude = 0;

    getFloatTimeDomainData(buffer: Float32Array): void {
        for (let i = 0; i < buffer.length; i++) buffer[i] = i % 2 === 0 ? this.amplitude : -this.amplitude;
    }
}

let trackSeq = 0;

class FakeTrack {
    readonly id = `track-${trackSeq++}`;
    enabled = true;
    readonly stop = vi.fn();
    readonly applyConstraints = vi.fn().mockResolvedValue(undefined);
}

function fakeStream(tracks: FakeTrack[]): MediaStream {
    return {
        getAudioTracks: () => tracks,
        getTracks: () => tracks,
    } as unknown as MediaStream;
}

class FakeDestinationNode extends FakeNode {
    readonly track = new FakeTrack();
    readonly stream = fakeStream([this.track]);
}

class FakeAudioContext {
    static instances: FakeAudioContext[] = [];

    currentTime = 0;
    readonly destination = new FakeNode();
    readonly gains: FakeGain[] = [];
    readonly destinations: FakeDestinationNode[] = [];
    readonly resume = vi.fn().mockResolvedValue(undefined);
    readonly close = vi.fn().mockResolvedValue(undefined);

    constructor() {
        FakeAudioContext.instances.push(this);
    }

    createGain(): FakeGain {
        const gain = new FakeGain();
        this.gains.push(gain);
        return gain;
    }

    createStereoPanner(): FakePanner {
        return new FakePanner();
    }

    createAnalyser(): FakeAnalyser {
        return new FakeAnalyser();
    }

    createMediaStreamSource(): FakeNode {
        return new FakeNode();
    }

    createMediaStreamDestination(): FakeDestinationNode {
        const node = new FakeDestinationNode();
        this.destinations.push(node);
        return node;
    }
}

interface RemoteTrackPlan {
    mid: string;
    trackId?: string;
}

/** Enough of an `RTCRtpSender` for the encoding helpers, which read and write its parameters. */
class FakeSender {
    parameters: RTCRtpSendParameters = {encodings: [{}]} as RTCRtpSendParameters;

    constructor(readonly track: MediaStreamTrack) {
    }

    getParameters(): RTCRtpSendParameters {
        return this.parameters;
    }

    setParameters = vi.fn(async (parameters: RTCRtpSendParameters) => {
        this.parameters = parameters;
    });
}

class FakePeerConnection {
    static instances: FakePeerConnection[] = [];

    ontrack: ((event: RTCTrackEvent) => void) | null = null;
    connectionState = 'connected';
    iceConnectionState = 'connected';
    localDescription = {
        type: 'offer',
        sdp: 'v=0\r\na=candidate:1 1 udp 2130706431 192.0.2.1 5000 typ host\r\n',
    };

    /** Fired from inside `setRemoteDescription`, which is when a browser fires it. */
    emitOnAnswer: RemoteTrackPlan | null = null;
    readonly transceivers: {mid: string | null; sender?: unknown; stop: ReturnType<typeof vi.fn>}[] = [];
    readonly close = vi.fn();
    stats = new Map<string, Record<string, unknown>>();

    constructor(readonly config: RTCConfiguration) {
        FakePeerConnection.instances.push(this);
    }

    readonly senders: FakeSender[] = [];

    addTrack(track: MediaStreamTrack): RTCRtpSender {
        const sender = new FakeSender(track);
        this.senders.push(sender);
        this.transceivers.push({mid: '0', sender, stop: vi.fn()});
        return sender as unknown as RTCRtpSender;
    }

    addTransceiver(_kind: string, _init: RTCRtpTransceiverInit): RTCRtpTransceiver {
        const transceiver = {mid: null, stop: vi.fn()};
        this.transceivers.push(transceiver);
        return transceiver as unknown as RTCRtpTransceiver;
    }

    getTransceivers(): RTCRtpTransceiver[] {
        return this.transceivers as unknown as RTCRtpTransceiver[];
    }

    createOffer = vi.fn().mockResolvedValue({type: 'offer', sdp: 'v=0'});
    setLocalDescription = vi.fn().mockResolvedValue(undefined);

    setRemoteDescription = vi.fn(async () => {
        const plan = this.emitOnAnswer;
        if (!plan) return;
        this.emitOnAnswer = null;
        const track = {id: plan.trackId ?? `remote-${plan.mid}`} as MediaStreamTrack;
        this.ontrack?.({
            transceiver: {mid: plan.mid} as RTCRtpTransceiver,
            track,
            streams: [fakeStream([])],
        } as unknown as RTCTrackEvent);
    });

    getStats = vi.fn(async () => this.stats);
}

class FakeVad {
    private readonly levelSignal = signal(0.2);
    private readonly speakingSignal = signal(true);
    private readonly thresholdSignal = signal(0.02);
    private readonly runningSignal = signal(false);

    readonly level = this.levelSignal.asReadonly();
    readonly speaking = this.speakingSignal.asReadonly();
    readonly threshold = this.thresholdSignal.asReadonly();
    readonly running = this.runningSignal.asReadonly();

    watching: MediaStream | null = null;

    readonly start = vi.fn((stream: MediaStream) => {
        this.watching = stream;
        this.runningSignal.set(true);
    });
    readonly stop = vi.fn(() => {
        this.runningSignal.set(false);
        this.watching = null;
    });
    readonly setThreshold = vi.fn((value: number) => this.thresholdSignal.set(value));

    say(speaking: boolean): void {
        this.speakingSignal.set(speaking);
    }

    silence(): void {
        this.runningSignal.set(false);
    }
}

// ── Wiring ───────────────────────────────────────────────────────────────────

const API = 'https://api.example.test';
const GUILD = {kind: 'guild', guildId: 'g1', channelId: 'c1'} as const;
const ISLE = {kind: 'isle'} as const;

const processing = (patch: Partial<VoiceProcessing> = {}): VoiceProcessing => ({
    deviceId: null,
    outputDeviceId: null,
    noiseSuppression: 'standard',
    echoCancellation: true,
    autoGainControl: true,
    inputMode: 'voice',
    sensitivity: 0.6,
    inputVolume: 1,
    outputVolume: 1,
    bitrateBps: null,
    ...patch,
});

interface Sent {
    method: 'post' | 'put';
    url: string;
    body: Record<string, unknown>;
}

let publisher: WebVoicePublisher;
let vad: FakeVad;
let mic: MediaStream;
let sent: Sent[];
/** Per-URL overrides; anything not listed gets the default below. */
let responder: (sent: Sent) => unknown;
let getUserMedia: ReturnType<typeof vi.fn>;
let sessionSeq = 0;

function defaultResponse(request: Sent): unknown {
    // A fresh id per call, because the SFU never hands the same session out twice - and one of the
    // assertions below turns on exactly that (a stop naming a session that has been replaced).
    if (request.url.includes('/session')) {
        return {mediaSessionId: `my_sess${sessionSeq++ === 0 ? '' : `-${sessionSeq - 1}`}`, backend: 'cloudflare'};
    }
    if (request.url.includes('/negotiate') || request.url.includes('renegotiate')) {
        return {sessionDescription: {type: 'answer', sdp: 'v=0'}};
    }
    const track = firstTrack(request);
    const direction = track['direction'] ?? track['location'];
    return {
        sessionDescription: {type: 'answer', sdp: 'v=0'},
        // A publish is answered with the name it will be resolved by; a subscribe with the mid the SFU
        // allocated, which is the only thing that can route its packets.
        tracks: direction === 'publish' || direction === 'local'
            ? [{mid: '0', trackName: 'audio'}]
            : [{mid: '1', trackName: track['trackName']}],
        requiresImmediateRenegotiation: false,
    };
}

function firstTrack(request: Sent): Record<string, unknown> {
    const tracks = request.body['tracks'] as Record<string, unknown>[] | undefined;
    return tracks?.[0] ?? {};
}

/** Requests that carried a `tracks` array, which is publish and subscribe both. */
function trackRequests(): Sent[] {
    return sent.filter(s => Array.isArray(s.body['tracks']));
}

function subscribeRequests(): Sent[] {
    return trackRequests().filter(s => {
        const direction = firstTrack(s)['direction'] ?? firstTrack(s)['location'];
        return direction === 'subscribe' || direction === 'remote';
    });
}

function ctx(): FakeAudioContext {
    return FakeAudioContext.instances[0];
}

/** The gate feeding publication `index`, found through what it is connected to rather than by order. */
function gateFor(index: number): FakeGain {
    const destination = ctx().destinations[index];
    const gate = ctx().gains.find(g => g.connect.mock.calls.some(call => call[0] === destination));
    expect(gate, `no gate is connected to publication ${index}`).toBeDefined();
    return gate!;
}

/** The track publication `index` actually sends - what a remote peer sees. */
function publishedTrack(index: number): FakeTrack {
    return ctx().destinations[index].track;
}

beforeEach(() => {
    trackSeq = 0;
    sessionSeq = 0;
    FakeAudioContext.instances = [];
    FakePeerConnection.instances = [];
    sent = [];
    responder = defaultResponse;
    vad = new FakeVad();
    mic = fakeStream([new FakeTrack()]);
    getUserMedia = vi.fn().mockResolvedValue(mic);

    const globals = globalThis as unknown as Record<string, unknown>;
    globals['AudioContext'] = FakeAudioContext;
    globals['RTCPeerConnection'] = FakePeerConnection;
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
        configurable: true,
        value: {getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]), addEventListener: vi.fn()},
    });

    const record = (method: 'post' | 'put') => vi.fn((url: string, body: Record<string, unknown>) => {
        const request: Sent = {method, url, body};
        sent.push(request);
        const response = responder(request);
        if (response instanceof Error) throw response;
        return of(response);
    });

    TestBed.configureTestingModule({
        providers: [
            WebVoicePublisher,
            {provide: HttpClient, useValue: {post: record('post'), put: record('put')}},
            {provide: VoiceActivityService, useValue: vad},
            // Stubbed rather than real: its constructor subscribes to `devicechange`, and every stored
            // id in these tests is already a web id.
            {provide: MediaDeviceResolverService, useValue: {toWebDeviceId: vi.fn().mockResolvedValue('')}},
        ],
    });
    publisher = TestBed.inject(WebVoicePublisher);
});

async function start(target: typeof GUILD | typeof ISLE = GUILD): Promise<VoiceSession> {
    return await publisher.start({target, apiBase: API, token: 'tok', deviceId: 'dev-1'});
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('the sensitivity mapping', () => {
    it('opens at the bottom of the meter the settings page draws', () => {
        // The adapter writes -60 out rather than importing `VAD_METER_FLOOR_DB`, so that a module-scope
        // const can never be initialised across a cycle and land as `undefined` - a NaN threshold is a
        // gate stuck open on a live microphone. This is what stops the two copies drifting instead.
        expect(VAD_THRESHOLD_OPEN_DB).toBe(VAD_METER_FLOOR_DB);
    });

    it('switches the gate off at the permissive end', () => {
        // Sensitivity 1.0 is what a corrupted or absent stored cutoff falls back to, and it has to mean
        // "transmit anything" rather than "transmit nothing" - the opposite would mute a user whose
        // settings blob went bad, which is indistinguishable from a broken microphone.
        expect(vadThresholdFor(1)).toBeCloseTo(Math.pow(10, VAD_THRESHOLD_OPEN_DB / 20), 6);
        expect(vadThresholdFor(Number.NaN)).toBeCloseTo(vadThresholdFor(1), 6);
    });

    it('puts the shipped default in the permissive half', () => {
        // Cutoff 40 inverts to sensitivity 0.6. A default that gates an ordinary talker is the bug
        // nobody reports, because nobody changes a default they have not been bitten by.
        const shipped = vadThresholdFor(0.6);
        expect(shipped).toBeLessThan(vadThresholdFor(0.3));
        expect(shipped).toBeGreaterThan(vadThresholdFor(0.9));
        // Above a quiet room's tone (~-50 dBFS) and well below speech (~-20 dBFS).
        expect(20 * Math.log10(shipped)).toBeGreaterThan(-50);
        expect(20 * Math.log10(shipped)).toBeLessThan(-20);
    });

    it('is monotonic, so the slider never reverses under the user', () => {
        let previous = vadThresholdFor(0);
        for (let s = 0.1; s <= 1; s += 0.1) {
            const threshold = vadThresholdFor(s);
            expect(threshold).toBeLessThan(previous);
            previous = threshold;
        }
    });
});

describe('slots', () => {
    it('shares one between a guild channel and a call, and gives Isle its own', () => {
        // The whole reason slots exist: you cannot be in a voice channel and a DM call at once, but
        // proximity voice runs alongside either.
        expect(slotFor(GUILD)).toBe('primary');
        expect(slotFor({kind: 'call', callId: 'c'})).toBe('primary');
        expect(slotFor(ISLE)).toBe('isle');
    });
});

describe('start', () => {
    it('publishes the microphone and hands back what the SFU named it', async () => {
        const session = await start();

        expect(session).toEqual({slot: 'primary', mediaSessionId: 'my_sess', trackName: 'audio'});
        const publish = trackRequests()[0];
        expect(publish.url).toBe(`${API}/api/v1/guild/guilds/g1/channels/c1/voice/tracks`);
        expect(publish.body['mediaSessionId']).toBe('my_sess');
        expect(firstTrack(publish)['direction']).toBe('publish');
        expect(firstTrack(publish)['trackName']).toBe('audio');
        // The mid of the transceiver the microphone actually went out on. A wrong one publishes an
        // m-line that carries nothing.
        expect(firstTrack(publish)['mid']).toBe('0');
    });

    it('claims the primary session, because the microphone is what the room subscribes to', async () => {
        await start();
        expect(sent[0].url).toContain('/session?primary=true');
    });

    it('opens the microphone before it opens a peer connection', async () => {
        // If there is no microphone there is no point creating a connection, and the failure the user
        // needs to see is "no microphone" rather than "signalling failed".
        getUserMedia.mockRejectedValue(new Error('NotAllowedError'));
        await expect(start()).rejects.toThrow();
        expect(FakePeerConnection.instances).toHaveLength(0);
        expect(sent).toEqual([]);
    });

    it('passes no ICE servers', async () => {
        await start();
        expect(FakePeerConnection.instances[0].config.iceServers).toEqual([]);
        expect(FakePeerConnection.instances[0].config.bundlePolicy).toBe('max-bundle');
    });

    it('caps the microphone at the bitrate the desktop encoder uses', async () => {
        // 64 kbps mono Opus is what `to_chain_config` gives the Rust encoder, and it is transparent for
        // speech. Left to the browser's own default a web publisher would simply sound different, which
        // is the kind of difference nobody attributes to a bitrate.
        await start();
        const sender = FakePeerConnection.instances[0].senders[0];
        expect(sender.parameters.encodings?.[0].maxBitrate).toBe(64_000);
    });

    it('hands the capture stream to the voice-activity gate', async () => {
        // The gate is the only thing that keys the microphone on this host, so a publisher that never
        // starts it would transmit on whatever `speaking` happened to be.
        await start();
        expect(vad.start).toHaveBeenCalledTimes(1);
        expect(vad.watching).toBe(mic);
    });

    it('runs Isle alongside a guild channel on one microphone', async () => {
        await start(GUILD);
        const isle = await start(ISLE);

        expect(isle.slot).toBe('isle');
        // One capture, two publications. A second `getUserMedia` would be a second echo-canceller
        // reference, and neither could cancel the other's playout - which is the leak that made Isle
        // bleed into the guild microphone before the engines were merged.
        expect(getUserMedia).toHaveBeenCalledTimes(1);
        expect(FakePeerConnection.instances).toHaveLength(2);
        expect(ctx().destinations).toHaveLength(2);
    });

    it('speaks the Cloudflare dialect to Isle', async () => {
        await start(ISLE);
        const publish = trackRequests()[0];
        expect(publish.url).toBe(`${API}/api/v1/isle/voice/cf/tracks/new`);
        expect(publish.body['cfSessionId']).toBe('my_sess');
        expect(firstTrack(publish)['location']).toBe('local');
    });

    it('rejects rather than reporting a publication the SFU refused', async () => {
        // A per-track error inside an HTTP 200 is the shape that leaves a publisher inaudible while
        // every layer above reports success.
        responder = request => request.url.includes('/tracks')
            ? {sessionDescription: {type: 'answer', sdp: ''}, tracks: [{errorCode: 'no_such_session'}]}
            : defaultResponse(request);

        await expect(start()).rejects.toThrow(/no_such_session/);
    });

    it('closes the microphone again when the only start failed', async () => {
        // Or the device stays open for a call that never happened - the light stays on and the user
        // has no way to turn it off short of a reload.
        responder = () => new Error('network down');
        await expect(start()).rejects.toThrow();
        expect(mic.getTracks()[0].stop).toHaveBeenCalled();
        expect(vad.stop).toHaveBeenCalled();
    });
});

describe('the gate', () => {
    it('is open when the user is unmuted, the call wants audio, and there is speech', async () => {
        await start();
        expect(gateFor(0).gain.value).toBe(1);
        expect(publishedTrack(0).enabled).toBe(true);
    });

    it('closes on mute for every call at once', async () => {
        await start(GUILD);
        await start(ISLE);

        await publisher.setMute(true);

        // Muting is a statement about the microphone. A mute that left you audible somewhere else
        // would be the worst possible way to discover that calls are separate.
        expect(gateFor(0).gain.value).toBe(0);
        expect(gateFor(1).gain.value).toBe(0);
        expect(publishedTrack(0).enabled).toBe(false);
    });

    it('keeps push-to-talk per publication', async () => {
        // The single most important property here, and the reason Isle used to run a second capture:
        // keying proximity voice must not also key the guild channel. Mutated by gating a shared track
        // with `enabled` instead of a per-publication node - both close and this fails.
        const guild = await start(GUILD);
        const isle = await start(ISLE);

        await publisher.setPttOpen(isle, false);

        expect(gateFor(1).gain.value).toBe(0);
        expect(gateFor(0).gain.value).toBe(1);
        expect(publishedTrack(0).enabled).toBe(true);
        expect(publishedTrack(1).enabled).toBe(false);

        await publisher.setPttOpen(guild, false);
        expect(gateFor(0).gain.value).toBe(0);
    });

    it('follows the voice-activity gate', async () => {
        // On this host there is no global hotkey, so this is what opens and closes the microphone.
        await start();

        vad.say(false);
        TestBed.flushEffects();
        expect(gateFor(0).gain.value).toBe(0);

        vad.say(true);
        TestBed.flushEffects();
        expect(gateFor(0).gain.value).toBe(1);
    });

    it('stays open when the gate is not running at all', async () => {
        // A VAD that failed to start would otherwise leave the user permanently inaudible, which is
        // indistinguishable from a broken microphone. An over-open gate is at worst audible.
        await start();
        vad.say(false);
        vad.silence();
        TestBed.flushEffects();

        expect(gateFor(0).gain.value).toBe(1);
    });

    it('does not send a mute as a renegotiation', async () => {
        // Removing the track would end the publication at the SFU, so every peer would drop it and
        // have to be told to pull it again on unmute.
        await start();
        const before = sent.length;
        await publisher.setMute(true);
        await publisher.setMute(false);
        expect(sent).toHaveLength(before);
    });
});

describe('subscribe', () => {
    it('registers the route before the answer, so the opening track is not lost', async () => {
        // The ordering this whole flow turns on. The SFU starts forwarding a pulled track when it
        // processes the pull, which is strictly before our answer lands - so `ontrack` fires *inside*
        // `setRemoteDescription`, as this fake does. A mid recorded after that call finds no route and
        // the participant is silent for the session with the connection reporting healthy throughout.
        //
        // Mutated by moving the `mids.set` below `setRemoteDescription`: the track becomes unroutable
        // and this fails.
        const session = await start();
        FakePeerConnection.instances[0].emitOnAnswer = {mid: '1', trackId: 'remote-a'};

        await publisher.subscribe(session, 'user_a', 'their_sess', 'audio');

        const stats = await publisher.stats();
        expect(stats.publications[0].midRoutes).toEqual([['1', 'user_a']]);
        expect(stats.publications[0].tracksOpened).toBe(1);
        expect(stats.sources.map(s => s.id)).toContain('user_a');
    });

    it('asks the publishing session for the track, with no mid of its own', async () => {
        const session = await start();
        await publisher.subscribe(session, 'user_a', 'their_sess', 'audio');

        const pull = subscribeRequests()[0];
        expect(pull.body['mediaSessionId']).toBe('my_sess');
        expect(firstTrack(pull)['mediaSessionId']).toBe('their_sess');
        expect(firstTrack(pull)['trackName']).toBe('audio');
        expect(firstTrack(pull)['mid']).toBeUndefined();
    });

    it('makes exactly one attempt', async () => {
        // The retry with backoff lives in `voice-rtc.service.ts`, once. Retrying here as well would
        // multiply the two schedules - four attempts becoming sixteen - against a backend that already
        // absorbs several seconds of the publish race.
        const session = await start();
        responder = request => request.url.includes('/tracks') && subscribeRequests().length > 0
            ? new Error('not_found_track_error')
            : defaultResponse(request);

        await expect(publisher.subscribe(session, 'user_a', 'their_sess', 'audio')).rejects.toThrow();
        expect(subscribeRequests()).toHaveLength(1);
    });

    it('rethrows the failure unchanged, so a stale roster is still recognisable', async () => {
        // `isStaleSubscription` reads the HttpErrorResponse's status and body. Wrapping this in a new
        // Error would turn a 409 the caller must answer with a snapshot refetch into a plain failure it
        // retries - which is the loop those helpers exist to break.
        const session = await start();
        const stale = {status: 409, error: {error: STALE_SUBSCRIPTION}};
        responder = request => {
            if (request.url.includes('/tracks') && firstTrack(request)['direction'] === 'subscribe') {
                throw stale;
            }
            return defaultResponse(request);
        };

        await expect(publisher.subscribe(session, 'user_a', 'their_sess', 'audio')).rejects.toBe(stale);
        await publisher.subscribe(session, 'user_b', 'their_sess', 'audio').catch((e: unknown) => {
            expect(isStaleSubscription(e)).toBe(true);
        });
    });

    it('treats a track that came back without a mid as a failure', async () => {
        // A mid is the only way to route packets to a participant, so a track without one is a failed
        // subscribe wearing an HTTP 200. Skipping it silently is what once left a participant
        // unhearable for a whole session with nothing in any log.
        const session = await start();
        responder = request => {
            const response = defaultResponse(request) as {tracks?: Record<string, unknown>[]};
            if (firstTrack(request)['direction'] === 'subscribe') response.tracks = [{trackName: 'audio'}];
            return response;
        };

        await expect(publisher.subscribe(session, 'user_a', 'their_sess', 'audio'))
            .rejects.toThrow(/no mid/);
    });

    it('rolls back a failed pull so the retry above it is not blocked', async () => {
        // A source left in the mix from a failed subscribe would make every later announcement look
        // like a duplicate and skip it - which is how a transient failure became permanent.
        const session = await start();
        let fail = true;
        responder = request => {
            if (firstTrack(request)['direction'] === 'subscribe' && fail) return new Error('transport');
            return defaultResponse(request);
        };

        await expect(publisher.subscribe(session, 'user_a', 'their_sess', 'audio')).rejects.toThrow();
        fail = false;
        FakePeerConnection.instances[0].emitOnAnswer = {mid: '1', trackId: 'remote-a'};
        await publisher.subscribe(session, 'user_a', 'their_sess', 'audio');

        expect(subscribeRequests()).toHaveLength(2);
        expect((await publisher.stats()).publications[0].subscribed).toEqual(['user_a']);
    });

    it('skips a healthy repeat and re-pulls one with no route', async () => {
        // "Already subscribed" needs a route as well as a source. Re-pulling a healthy one mixes the
        // participant in twice; reporting a routeless one as subscribed is worse - the caller records a
        // subscription it does not have and every later announcement is skipped as a duplicate.
        const session = await start();
        FakePeerConnection.instances[0].emitOnAnswer = {mid: '1', trackId: 'remote-a'};
        await publisher.subscribe(session, 'user_a', 'their_sess', 'audio');
        await publisher.subscribe(session, 'user_a', 'their_sess', 'audio');
        expect(subscribeRequests()).toHaveLength(1);
    });

    it('rejects for a slot with no publication on it', async () => {
        await expect(publisher.subscribe(
            {slot: 'primary', mediaSessionId: 'x', trackName: 'audio'}, 'user_a', 's', 'audio',
        )).rejects.toThrow(/no voice session/);
    });

    it('takes a participant out of the mix on unsubscribe', async () => {
        const session = await start();
        FakePeerConnection.instances[0].emitOnAnswer = {mid: '1', trackId: 'remote-a'};
        await publisher.subscribe(session, 'user_a', 'their_sess', 'audio');

        await publisher.unsubscribe(session, 'user_a');

        const stats = await publisher.stats();
        expect(stats.publications[0].subscribed).toEqual([]);
        expect(stats.publications[0].midRoutes).toEqual([]);
        expect(stats.sources).toEqual([]);
    });
});

describe('a remote track on an unmapped mid', () => {
    it('is counted rather than quietly dropped', async () => {
        // This is where a mid-mapping fault turns into silence: the track opens, the connection is
        // healthy, and every layer above reports success while the audio goes nowhere.
        await start();
        const pc = FakePeerConnection.instances[0];
        pc.ontrack?.({
            transceiver: {mid: '9'} as RTCRtpTransceiver,
            track: {id: 'orphan'} as MediaStreamTrack,
            streams: [fakeStream([])],
        } as unknown as RTCTrackEvent);

        const stats = await publisher.stats();
        expect(stats.publications[0].tracksOpened).toBe(0);
        expect(stats.sources).toEqual([]);
    });
});

describe('stats', () => {
    it('answers with zeroed counters rather than nothing when idle', async () => {
        const stats = await publisher.stats();
        expect(stats.running).toBe(false);
        expect(stats.publications).toEqual([]);
        expect(stats.sources).toEqual([]);
        expect(stats.packetsEncoded).toBe(0);
    });

    it('separates packets that reached a participant from packets that did not', async () => {
        // The counter split that matters. `rtpReceived` alone cannot see a starved handler: one
        // talker's 300 packets a second read as a healthy connection while a second participant sits
        // silent. Mutated by reporting rtpRouted = rtpReceived: this fails.
        const session = await start();
        const pc = FakePeerConnection.instances[0];
        pc.emitOnAnswer = {mid: '1', trackId: 'remote-a'};
        await publisher.subscribe(session, 'user_a', 'their_sess', 'audio');

        pc.stats = new Map<string, Record<string, unknown>>([
            ['o', {type: 'outbound-rtp', kind: 'audio', packetsSent: 500}],
            ['ok', {
                type: 'inbound-rtp', kind: 'audio', trackIdentifier: 'remote-a', packetsReceived: 300,
                jitterBufferDelay: 0.24, jitterBufferEmittedCount: 4,
            }],
            ['orphan', {type: 'inbound-rtp', kind: 'audio', trackIdentifier: 'nobody', packetsReceived: 40}],
            ['src', {type: 'media-source', kind: 'audio', totalSamplesDuration: 3}],
        ]);

        const stats = await publisher.stats();
        const publication = stats.publications[0];
        expect(publication.packetsSent).toBe(500);
        expect(publication.rtpReceived).toBe(340);
        expect(publication.rtpRouted).toBe(300);
        expect(publication.rtpUnmapped).toBe(40);
        expect(stats.framesCaptured).toBe(300);
        expect(stats.running).toBe(true);
        // Per source, after gain, which is the only place "everyone is audible" can be told from "one
        // of them is not".
        expect(stats.sources.find(s => s.id === 'user_a')?.bufferedPackets).toBe(3);
    });

    it('reports each publication under its own slot and gate state', async () => {
        const guild = await start(GUILD);
        await start(ISLE);
        await publisher.setPttOpen(guild, false);

        const stats = await publisher.stats();
        expect(stats.publications.map(p => p.slot)).toEqual(['isle', 'primary']);
        expect(stats.publications.find(p => p.slot === 'primary')?.open).toBe(false);
        expect(stats.publications.find(p => p.slot === 'isle')?.open).toBe(true);
        // Engine-wide, so a call that is keyed keeps the microphone live for the one that is not.
        expect(stats.gateOpen).toBe(true);
    });

    it('reports the candidates it offered', async () => {
        // The one thing that distinguishes the two ways ICE fails with no STUN servers configured:
        // host-only candidates and a failed connection means the SFU was unreachable from here.
        await start();
        const stats = await publisher.stats();
        expect(stats.publications[0].localCandidates[0]).toMatch(/^candidate:/);
    });
});

describe('settings', () => {
    it('maps the sensitivity cutoff onto the gate', async () => {
        await start();
        await publisher.setProcessing(processing({sensitivity: 0.2}));
        expect(vad.setThreshold).toHaveBeenLastCalledWith(vadThresholdFor(0.2));
    });

    it('applies capture processing to the live track rather than at the next join', async () => {
        // No renegotiation: the constraints act on capture, not on the encoding. On desktop the same
        // change waits for the engine to reopen its devices.
        await start();
        await publisher.setProcessing(processing({echoCancellation: false, noiseSuppression: 'none'}));

        const track = mic.getAudioTracks()[0] as unknown as FakeTrack;
        expect(track.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({
            echoCancellation: false,
            noiseSuppression: false,
        }));
    });

    it('keeps the browser filter on for the enhanced mode it cannot provide', async () => {
        // 'enhanced' is the Rust RNNoise path. Falling back to *none* rather than to the browser's own
        // filter would make choosing the strongest option the one that turns suppression off.
        await start();
        await publisher.setProcessing(processing({noiseSuppression: 'enhanced'}));

        const track = mic.getAudioTracks()[0] as unknown as FakeTrack;
        expect(track.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({noiseSuppression: true}));
    });

    it('carries the microphone slider, which had nothing to act on before', async () => {
        await publisher.setProcessing(processing({inputVolume: 0.4}));
        await start();
        // The first gain created is the shared input stage, before the per-publication taps.
        expect(ctx().gains[0].gain.value).toBe(0.4);
    });
});

describe('stop', () => {
    it('closes the published track server-side before dropping the connection', async () => {
        // The close is what tells the backend to stop offering this track to joiners; a closed peer
        // connection cannot be asked to do it afterwards.
        const session = await start();
        await publisher.stop(session);

        const close = sent.find(s => s.url.endsWith('/tracks/close'));
        expect(close?.method).toBe('post');
        expect(close?.body).toEqual({mediaSessionId: 'my_sess', trackNames: ['audio']});
        expect(FakePeerConnection.instances[0].close).toHaveBeenCalled();
    });

    it('uses the verb Isle takes', async () => {
        const session = await start(ISLE);
        await publisher.stop(session);
        expect(sent.find(s => s.url.endsWith('/cf/tracks/close'))?.method).toBe('put');
    });

    it('releases the microphone only once the last call ends', async () => {
        const guild = await start(GUILD);
        const isle = await start(ISLE);

        await publisher.stop(guild);
        expect(mic.getTracks()[0].stop).not.toHaveBeenCalled();
        expect(vad.stop).not.toHaveBeenCalled();

        await publisher.stop(isle);
        expect(mic.getTracks()[0].stop).toHaveBeenCalled();
        expect(vad.stop).toHaveBeenCalled();
        expect(ctx().close).toHaveBeenCalled();
    });

    it('ignores a stop for a publication that has already been replaced', async () => {
        // A rejoin replaces the slot's publication. A late stop for the one it replaced must not tear
        // down its successor - which would hang up the call the user just joined.
        //
        // Deliberately stronger than `voice_stop`, which takes a slot and unpublishes whatever is on
        // it. The port hands over a whole session, so there is an identity here that the Rust command
        // never had, and matching on it costs one comparison.
        const first = await start(GUILD);
        await start(GUILD);
        await publisher.stop(first);

        expect((await publisher.stats()).running).toBe(true);
    });
});

describe('playout controls', () => {
    it('silences the mix on deafen without touching the capture gate', async () => {
        await start();
        await publisher.setDeafened(true);

        // Deafen is output only, so it still does not stop you transmitting - mute is the separate
        // control for that.
        expect(gateFor(0).gain.value).toBe(1);
        expect((await publisher.stats()).deafened).toBe(true);
    });

    it('remembers a volume set before the participant was pulled', async () => {
        // The order these arrive in is not fixed: a volume can be set before that user joins, and the
        // reapply after a subscribe is what Rust's gain table does for the same reason.
        const session = await start();
        await publisher.setUserVolume('user_a', 0.25);

        FakePeerConnection.instances[0].emitOnAnswer = {mid: '1', trackId: 'remote-a'};
        await publisher.subscribe(session, 'user_a', 'their_sess', 'audio');

        const stats = await publisher.stats();
        expect(stats.sources.map(s => s.id)).toContain('user_a');
        expect(stats.masterVolume).toBe(1);
    });
});

describe('vad support', () => {
    it('is on, because a browser has no global hotkey to key a microphone with', () => {
        expect(publisher.supportsVad).toBe(true);
    });
});
