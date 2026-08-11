import {effect, inject, Injectable, untracked} from '@angular/core';
import {HttpClient} from '@angular/common/http';
// The only two service imports here, and neither is a service this adapter backs.
//
// `MediaDeviceResolverService` translates a stored device *name* into the origin-salted id the web
// media APIs accept, and it imports nothing but `@angular/core` - so it cannot take part in a cycle
// with this file. `VoiceActivityService` is the capture gate this adapter drives. Nothing else is
// imported from `src/app/services`: an adapter that imported a value from `voice-engine.service.ts`,
// the service it stands behind, would be one refactor away from a module-scope constant evaluating to
// `undefined` across a cycle - and a `NaN` threshold is a gate stuck open, on a proximity microphone,
// with nothing logged. `SILENCE_DBFS` lives on the port for exactly that reason.
import {MediaDeviceResolverService} from '../../services/media-device-resolver.service';
import {VoiceActivityService} from '../../services/voice-activity.service';
import {
    Position,
    SILENCE_DBFS,
    PublicationStats,
    SourceStats,
    SpatialModel,
    VoiceProcessing,
    VoicePublisher,
    VoicePublisherEvent,
    VoiceSession,
    VoiceStartOptions,
    VoiceStats,
    VoiceTarget,
} from '../ports/voice-publisher.port';
import {
    DEFAULT_SPATIAL_MODEL,
    REMOTE_LEVEL_INTERVAL_MS,
    VoiceMixer,
} from './voice-mixer';
import {trackError, VOICE_TRACK_NAME, VoiceSignalling} from './voice-signalling';
// The same helper and the same number the camera and screen senders use. `VOICE_AUDIO_KBPS` is 64,
// which is what `VoiceSettings::to_chain_config` gives the Rust Opus encoder by default - so a browser
// publisher sounds like a desktop one rather than like whatever the browser picked.
import {applySimpleBitrate, VOICE_AUDIO_KBPS} from '../../services/webrtc-encoding';

/**
 * A real WebRTC microphone publisher, for the browser.
 *
 * <p>This is the browser's stand-in for the whole of `src-tauri/src/media/voice`: capture, gating,
 * transport, and - because there is no Rust mixer either - playout of everyone it pulls. It publishes
 * to the same SFU, through the same backend routes, under the same track name, so a participant on a
 * browser and one on the desktop app are indistinguishable to everybody else in the room.</p>
 *
 * <h3>Shape, and why it mirrors the Rust engine rather than inventing one</h3>
 *
 * <p>One capture, many publications. A guild channel (or DM call) and Isle proximity voice are two
 * <i>publications</i> - two peer connections to two SFU sessions - sharing one microphone and one
 * output graph, occupying the slots `primary` and `isle` exactly as `session.rs` does. The sharing is
 * load-bearing in the same way: two independent captures would each carry the other's playout into
 * their own microphone with no echo canceller able to see it.</p>
 *
 * <p>Per-publication gating is what makes that safe - proximity push-to-talk must not also key the
 * guild channel - so each publication gets its own tap off the shared capture graph rather than a
 * second copy of the microphone track. Gating a shared `MediaStreamTrack` with `enabled` cannot work:
 * `enabled` is a property of the track, so muting one publication would mute both.</p>
 *
 * <h3>What is deliberately not here</h3>
 *
 * <p><b>No retry.</b> {@link subscribe} makes one attempt and rejects, because the retry with backoff
 * already exists one layer up in `voice-rtc.service.ts` and the backend absorbs several seconds of the
 * publish race before that. Retrying here too would multiply the two schedules together - four
 * attempts becoming sixteen - which is the shape of the stampede incident VNT-GE21R3P7 was about.
 * Rejecting rather than resolving quietly is the contract: nothing else retries, so a swallowed error
 * is a participant who stays silent for the rest of the session.</p>
 *
 * <p><b>No wait for ICE gathering.</b> The offer goes out as soon as `setLocalDescription` resolves,
 * which is what `voice-rtc.service.ts` has always done against this same SFU. The Rust publisher waits
 * because it has no other path for its candidates; in a browser it is unnecessary, and the SFU is an
 * `ice-lite` agent that only ever answers checks we send from candidates we gather locally.</p>
 */

/**
 * The strictest and most permissive cutoffs the sensitivity slider maps onto, in dBFS.
 *
 * <p>-14 dBFS is roughly the level of speech at headset distance, so sensitivity 0 transmits only
 * clearly loud speech. -60 dBFS is the bottom of the meter - below it an input is indistinguishable
 * from a dead microphone - so sensitivity 1 is the gate switched off, which is the documented meaning
 * of a permissive 1.0 and the value a corrupted setting falls back to.</p>
 *
 * <p>-60 is written out rather than read from `VAD_METER_FLOOR_DB`, which is the same number in
 * `voice-activity.service.ts`. Deliberate: a module-scope const initialised from an import is the one
 * shape that can silently become `undefined` if a cycle ever appears through this file, and a `NaN`
 * threshold is a gate stuck open on a live microphone. The two are asserted equal in the spec, so the
 * duplication cannot drift instead.</p>
 */
export const VAD_THRESHOLD_STRICT_DB = -14;
export const VAD_THRESHOLD_OPEN_DB = -60;

/**
 * The capture gate's cutoff, from the engine's 0.0-1.0 sensitivity.
 *
 * <p>Linear in dB rather than in amplitude, because that is the scale the microphone and the slider
 * both live on: linear interpolation would put nine tenths of the slider's travel inside the bottom
 * 3 dB. The shipped default (cutoff 40, so sensitivity 0.6) lands near -42 dBFS - above a quiet room's
 * tone and a good 15 dB below ordinary speech.</p>
 *
 * <p>It errs <b>open</b> at both ends of the guard, deliberately: a default that gates an ordinary
 * talker is the bug nobody reports, because nobody changes a default they have not been bitten by.</p>
 *
 * <p>Unlike the Rust gate this cutoff is absolute rather than measured against the room's own noise
 * floor - see the parity notes in the port docs. A noisy room may need the cutoff slider raised where
 * desktop would have adapted on its own.</p>
 */
export function vadThresholdFor(sensitivity: number): number {
    const clamped = Number.isFinite(sensitivity) ? Math.min(1, Math.max(0, sensitivity)) : 1;
    const db = VAD_THRESHOLD_STRICT_DB + clamped * (VAD_THRESHOLD_OPEN_DB - VAD_THRESHOLD_STRICT_DB);
    return Math.pow(10, db / 20);
}

/**
 * Which slot a target occupies. Mirrors `slot_for` in `media::voice`.
 *
 * <p>A guild channel and a DM call share one, because they are mutually exclusive; Isle proximity
 * voice gets its own and runs alongside either. That is the entire reason slots exist.</p>
 */
export function slotFor(target: VoiceTarget): string {
    return target.kind === 'isle' ? 'isle' : 'primary';
}

/**
 * Whether a publication should be routed audio the moment it starts.
 *
 * <p><b>Always true on web, unlike `starts_open` in `session.rs`.</b> Push-to-talk starts a desktop
 * publication closed because a global hotkey will open it; in a browser that key cannot be delivered
 * while the game has focus, so a publication that started closed would wait for a gesture that never
 * arrives. The voice-activity gate is what opens and closes it instead - which is the whole substance
 * of "VAD replaces PTT on web".</p>
 */
export function startsOpenOnWeb(): boolean {
    return true;
}

/** Whether any negotiated mid routes to `id` - see `routes_to` in `session.rs`. */
export function routesTo(mids: ReadonlyMap<string, string>, id: string): boolean {
    for (const sourceId of mids.values()) if (sourceId === id) return true;
    return false;
}

/** One publication's counters, kept per publication so one call's deltas are never another's. */
interface Counters {
    tracksOpened: number;
    /** Remote tracks that opened on a mid nothing was expecting. See {@link WebVoicePublisher.route}. */
    unroutableTracks: number;
}

interface Publication {
    readonly slot: string;
    readonly target: VoiceTarget;
    readonly signalling: VoiceSignalling;
    readonly pc: RTCPeerConnection;
    readonly mediaSessionId: string;
    readonly destination: MediaStreamAudioDestinationNode;
    /** The audible gate for this publication - 0 or 1, ramped so keying does not click. */
    readonly gate: GainNode;
    readonly track: MediaStreamTrack;
    trackName: string;
    /** What the *caller* wants: `setPttOpen`. Independent of mute and of the speech gate. */
    callerOpen: boolean;
    /** mid -> source id, written before the answer is applied. Per publication: mids repeat. */
    readonly mids: Map<string, string>;
    /** MediaStreamTrack.id -> source id, so `getStats` can attribute packets per participant. */
    readonly trackSources: Map<string, string>;
    readonly subscribed: Set<string>;
    /** Serialises offer/answer cycles: JSEP allows exactly one negotiation in flight. */
    negotiation: Promise<unknown>;
    readonly onEvent?: (event: VoicePublisherEvent) => void;
    readonly counters: Counters;
}

@Injectable()
export class WebVoicePublisher extends VoicePublisher {
    /** VAD is the only way to key a microphone while a game has focus. See `capabilities.ts`. */
    readonly supportsVad = true;

    private readonly http = inject(HttpClient);
    private readonly vad = inject(VoiceActivityService);
    private readonly deviceResolver = inject(MediaDeviceResolverService);

    private readonly publications = new Map<string, Publication>();

    // ── Shared capture graph ──────────────────────────────────────────────────
    private ctx: AudioContext | null = null;
    private mic: MediaStream | null = null;
    private micNode: MediaStreamAudioSourceNode | null = null;
    /** The microphone slider, applied once for every publication rather than per publication. */
    private inputGain: GainNode | null = null;
    private mixer: VoiceMixer | null = null;
    /** The web device id the current capture was opened with, so a device change is detectable. */
    private openedDeviceId = '';

    private processing: VoiceProcessing | null = null;
    private muted = false;
    private deafened = false;
    private outputVolume = 1;
    private spatialModel: SpatialModel = DEFAULT_SPATIAL_MODEL;

    /**
     * Volumes and positions for sources that may not be pulled yet.
     *
     * <p>Held rather than applied straight through, because both arrive out of order with the
     * subscribe: a per-user volume can be set before that user joins, and the game sends positions for
     * peers the SFU has not finished handing over. Rust keeps the same two tables in `Control` for
     * exactly this reason, and dropping a value here would lose a slider position silently.</p>
     */
    private readonly volumes = new Map<string, number>();
    private readonly positions = new Map<string, Position['position']>();

    private levelTimer: ReturnType<typeof setInterval> | null = null;
    /** Reported so a caller can tell an idle engine from a broken one - see {@link stats}. */
    private captureStartedAt = 0;

    constructor() {
        super();
        // The speech gate, and the local speaking indicator, on the same edge.
        //
        // Only `speaking()` is tracked: `level()` moves fifty times a second and reading it here would
        // re-run this effect at that rate. The level is read untracked for the event payload, which is
        // also emitted on a timer for the meter.
        effect(() => {
            const speaking = this.vad.speaking();
            untracked(() => {
                this.applyGates();
                this.emitSpeaking(speaking);
            });
        });
    }

    // ── Publication lifetime ──────────────────────────────────────────────────

    async start(o: VoiceStartOptions): Promise<VoiceSession> {
        // The microphone first: if it is unavailable there is no point creating a peer connection, and
        // the failure the user needs to see is "no microphone", not "signalling failed".
        const {ctx, inputGain} = await this.ensureCapture();

        const signalling = new VoiceSignalling(this.http, o.apiBase, o.target);
        const slot = slotFor(o.target);

        // Per-publication tap off the shared capture. A gain rather than a cloned track, so gating
        // this publication cannot gate any other - see the class notes.
        const gate = ctx.createGain();
        const destination = ctx.createMediaStreamDestination();
        inputGain.connect(gate);
        gate.connect(destination);
        const track = destination.stream.getAudioTracks()[0];
        if (!track) {
            gate.disconnect();
            throw new Error('the browser produced no audio track for the microphone');
        }

        // No ICE servers, matching the Rust publisher and the DM call path: the SFU is publicly
        // routable and answers to whatever source address it sees. `max-bundle` keeps every later
        // subscribe on the one transport.
        const pc = new RTCPeerConnection({iceServers: [], bundlePolicy: 'max-bundle'});

        const publication: Publication = {
            slot,
            target: o.target,
            signalling,
            pc,
            mediaSessionId: '',
            destination,
            gate,
            track,
            trackName: VOICE_TRACK_NAME,
            callerOpen: startsOpenOnWeb(),
            mids: new Map(),
            trackSources: new Map(),
            subscribed: new Set(),
            negotiation: Promise.resolve(),
            onEvent: o.onEvent,
            counters: {tracksOpened: 0, unroutableTracks: 0},
        };

        pc.ontrack = event => this.route(publication, event);

        try {
            const sender = pc.addTrack(track, destination.stream);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            const mediaSessionId = await signalling.createSession();
            // Assigned during offer creation, so it can only be read now.
            const mid = pc.getTransceivers().find(t => t.sender === sender)?.mid ?? '0';

            const response = await signalling.publish(
                mediaSessionId,
                {type: 'offer', sdp: pc.localDescription?.sdp ?? offer.sdp ?? ''},
                [{mid, trackName: VOICE_TRACK_NAME}],
            );

            // Every track, not only the first: a 200 whose track failed is the shape that leaves a
            // publisher inaudible while every layer above reports success.
            const failure = trackError(response.tracks);
            if (failure) throw new Error(`the SFU rejected the microphone track: ${failure}`);

            await pc.setRemoteDescription(response.sessionDescription as RTCSessionDescriptionInit);

            const connected: Publication = {
                ...publication,
                mediaSessionId,
                trackName: response.tracks?.[0]?.trackName ?? VOICE_TRACK_NAME,
            };
            // `ontrack` was installed against the object above, so the handler has to follow the
            // record that is actually registered or a pulled track would route into a discarded map.
            pc.ontrack = event => this.route(connected, event);

            if (response.requiresImmediateRenegotiation) await this.renegotiate(connected);
            // After the answer, because the sender has no parameters to set until it is negotiated.
            await applySimpleBitrate(sender, VOICE_AUDIO_KBPS);

            // Only now is the previous publication in this slot torn down. A rejoin that fails must
            // leave the existing call alone rather than dropping it on the way out - the same ordering
            // `Engine::attach` uses.
            const previous = this.publications.get(slot);
            if (previous) await this.teardown(previous);

            this.publications.set(slot, connected);
            this.applyGates();
            this.startLevelReports();

            return {slot, mediaSessionId, trackName: connected.trackName};
        } catch (e) {
            pc.close();
            gate.disconnect();
            destination.disconnect();
            // Close the devices again if this was the only thing that wanted them, rather than
            // leaving the microphone open for a call that never happened - `stop_engine_if_idle`.
            this.releaseCaptureIfIdle();
            throw e;
        }
    }

    async stop(s: VoiceSession): Promise<void> {
        const publication = this.publications.get(s.slot);
        // Matched on the session as well as the slot: a rejoin replaces the slot's publication, and a
        // late stop for the one it replaced must not tear down its successor.
        if (!publication || publication.mediaSessionId !== s.mediaSessionId) return;
        this.publications.delete(s.slot);
        await this.teardown(publication);
        this.releaseCaptureIfIdle();
    }

    // ── Subscription ──────────────────────────────────────────────────────────

    /**
     * Pull one participant's audio into the mix.
     *
     * <p>Serialised per publication, and the mid-to-source mapping is written <b>before</b> the answer
     * is applied. That ordering is not tidiness: the SFU starts forwarding a pulled track when it
     * processes the pull, which is strictly before our answer lands, so `ontrack` can fire inside
     * `setRemoteDescription`. A map written after this returns loses the opening packets of every
     * subscription, and on a browser it loses the whole track - there is no second `ontrack`.</p>
     */
    subscribe(s: VoiceSession, id: string, mediaSessionId: string, trackName: string): Promise<void> {
        const publication = this.publications.get(s.slot);
        if (!publication) return Promise.reject(new Error(`no voice session is running for ${s.slot}`));
        return this.enqueue(publication, () => this.pull(publication, id, mediaSessionId, trackName));
    }

    /**
     * Take a participant out of the mix.
     *
     * <p>Local only, exactly like `Publication::unsubscribe`: there is no "unpull" on this SFU, so the
     * track keeps arriving and is dropped here. Its mid routes go with it, or a later subscribe for the
     * same participant would find a stale route and skip the repair.</p>
     */
    async unsubscribe(s: VoiceSession, id: string): Promise<void> {
        const publication = this.publications.get(s.slot);
        if (!publication) return;
        this.drop(publication, id);
    }

    // ── Gating ────────────────────────────────────────────────────────────────

    /** Open or close the microphone for one call. Proximity PTT must not also key the guild channel. */
    async setPttOpen(s: VoiceSession, open: boolean): Promise<void> {
        const publication = this.publications.get(s.slot);
        if (!publication) return;
        publication.callerOpen = open;
        this.applyGates();
    }

    /**
     * Mute the microphone itself, for every call at once.
     *
     * <p><b>Gated, not removed.</b> Taking the track out of each sender would mean a renegotiation per
     * mute, and the SFU would see the publication end - so every peer would drop the track and have to
     * be told to pull it again on unmute. A gated publication keeps sending, at silence, which is what
     * the Rust engine's remote peers observe too: its gate stops producing packets, their jitter buffer
     * starves, and their meter reads zero. Either way the room hears nothing and nobody has to
     * resubscribe. What differs is the packet rate, not the outcome - see the parity notes.</p>
     */
    async setMute(muted: boolean): Promise<void> {
        this.muted = muted;
        this.applyGates();
    }

    // ── Playout ───────────────────────────────────────────────────────────────

    async setDeafened(deafened: boolean): Promise<void> {
        this.deafened = deafened;
        this.mixer?.setDeafened(deafened);
    }

    async setUserVolume(userId: string, volume: number): Promise<void> {
        const clamped = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
        this.volumes.set(userId, clamped);
        this.mixer?.setVolume(userId, clamped);
    }

    // ── Settings ──────────────────────────────────────────────────────────────

    /**
     * Capture processing, mapped onto what a browser actually exposes.
     *
     * <p>Echo cancellation, noise suppression and auto-gain are the browser's own constraints rather
     * than `webrtc-audio-processing-sys`, and they are applied to the live track: a settings change
     * mid-call takes effect immediately, with no renegotiation, because the constraints act on capture
     * and not on the encoding.</p>
     *
     * <p>The <b>input device</b> is the one setting that cannot be applied that way - Chromium ignores
     * a `deviceId` in `applyConstraints` - so a device change reopens the microphone and rewires it
     * into the same graph. Every publication is downstream of that graph, so nothing renegotiates and
     * no peer notices. On desktop the same change waits for the last call to end.</p>
     */
    async setProcessing(p: VoiceProcessing): Promise<void> {
        this.processing = p;

        this.outputVolume = clampGain(p.outputVolume);
        this.mixer?.setOutputVolume(this.outputVolume);
        if (this.inputGain) this.inputGain.gain.value = clampGain(p.inputVolume);
        this.vad.setThreshold(vadThresholdFor(p.sensitivity));

        if (!this.mic) return;

        // The output device too, not only the input: both are chosen in the same settings page, and a
        // speaker change that took effect only at the next join would be the "moved, saved, changed
        // nothing" bug from the other side.
        await this.applySinkId();

        const wanted = await this.deviceResolver.toWebDeviceId('audioinput', p.deviceId ?? 'default');
        if (wanted !== this.openedDeviceId) {
            await this.reopenMicrophone(wanted);
            return;
        }

        const track = this.mic.getAudioTracks()[0];
        if (!track) return;
        try {
            await track.applyConstraints(this.constraintsFor(p, wanted));
        } catch (e) {
            // A browser that refuses one of these keeps the previous setting. Reported rather than
            // swallowed: a noise-suppression toggle that silently did nothing is the bug class the
            // capability rules exist to prevent.
            console.warn('[voice] the browser refused the capture constraints', e);
        }
    }

    // ── Spatial ───────────────────────────────────────────────────────────────

    async setSpatialModel(m: SpatialModel): Promise<void> {
        // Applied through the mixer, which rejects a model that would silence every placed source
        // rather than half-applying it. Stored first so a publication starting later inherits it.
        this.spatialModel = m;
        this.mixer?.setSpatialModel(m);
    }

    async setPosition(p: Position): Promise<void> {
        this.positions.set(p.id, p.position);
        this.mixer?.setPosition(p.id, p.position);
    }

    // ── Diagnostics ───────────────────────────────────────────────────────────

    /**
     * Every counter this pipeline has, per publication and per source.
     *
     * <p>Aggregates are what made "the call connects and nobody can hear anything" unattributable: one
     * talker's 300 packets a second reads as a healthy connection while a second participant sits
     * silent. So `rtpReceived` is split into what was routed to a source and what was not, per
     * publication, and every source reports its own level.</p>
     *
     * <p>Zeroed with `running: false` rather than null when nothing is up, so a caller never has to
     * tell "no engine" from "engine idle" before it can render a number.</p>
     */
    async stats(): Promise<VoiceStats> {
        const publications: PublicationStats[] = [];
        const sourceLevels = new Map(this.mixer?.report().map(s => [s.id, s.level]) ?? []);
        const sources: SourceStats[] = [];

        let framesCaptured = 0;
        let packetsEncoded = 0;

        for (const publication of [...this.publications.values()].sort((a, b) => a.slot.localeCompare(b.slot))) {
            const read = await this.readStats(publication);
            publications.push(read.publication);
            // Gauges of one shared capture, so the largest reading rather than a sum: two
            // publications encoding the same microphone must not read as twice the microphone.
            framesCaptured = Math.max(framesCaptured, read.framesCaptured);
            packetsEncoded = Math.max(packetsEncoded, read.publication.packetsSent);
            for (const source of read.sources) {
                sources.push({...source, level: sourceLevels.get(source.id) ?? source.level});
            }
        }

        // Sources in the mix that no publication reported on - pulled, but with nothing arriving.
        for (const [id, level] of sourceLevels) {
            if (!sources.some(s => s.id === id)) sources.push({id, level, bufferedPackets: 0});
        }
        sources.sort((a, b) => a.id.localeCompare(b.id));

        return {
            running: this.publications.size > 0,
            framesCaptured,
            captureRms: this.vad.level(),
            packetsEncoded,
            muted: this.muted,
            gateOpen: [...this.publications.values()].some(p => this.gateOpenFor(p)),
            // Render quanta the graph has produced, as 10 ms frames, so it is the same unit as the
            // Rust playout counter: a mixer whose clock is not advancing is a stalled audio thread.
            playoutFrames: this.ctx ? Math.round(Math.max(0, this.ctx.currentTime * 1000 - this.captureStartedAt) / 10) : 0,
            mixRms: this.mixer?.mixRms() ?? 0,
            deafened: this.deafened,
            masterVolume: this.outputVolume,
            sources,
            publications,
        };
    }

    // ── Capture ───────────────────────────────────────────────────────────────

    /**
     * Open the microphone and the shared graph, once.
     *
     * <p>The VAD watches the raw capture stream rather than anything downstream of the microphone
     * slider: "am I speaking" is a question about the room, and a user who turned their input volume
     * down would otherwise fall below their own gate and go silent with no way to tell why.</p>
     */
    private async ensureCapture(): Promise<{ctx: AudioContext; inputGain: GainNode}> {
        if (this.ctx && this.inputGain) return {ctx: this.ctx, inputGain: this.inputGain};

        const processing = this.processing;
        const deviceId = processing
            ? await this.deviceResolver.toWebDeviceId('audioinput', processing.deviceId ?? 'default')
            : '';
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: this.constraintsFor(processing, deviceId),
            video: false,
        });

        const ctx = new AudioContext();
        // Normally already running, because a granted microphone satisfies the autoplay policy.
        // Resumed anyway: a suspended context renders nothing, which shows up as a mixer that plays
        // no remote audio rather than as an error.
        void ctx.resume().catch(e => console.warn('[voice] could not resume the audio context', e));

        const inputGain = ctx.createGain();
        inputGain.gain.value = clampGain(processing?.inputVolume ?? 1);
        const micNode = ctx.createMediaStreamSource(stream);
        micNode.connect(inputGain);

        const mixer = new VoiceMixer(ctx);
        mixer.setOutputVolume(this.outputVolume);
        mixer.setDeafened(this.deafened);
        try {
            mixer.setSpatialModel(this.spatialModel);
        } catch (e) {
            console.warn('[voice] keeping the default spatial model', e);
        }

        this.ctx = ctx;
        this.mic = stream;
        this.micNode = micNode;
        this.inputGain = inputGain;
        this.mixer = mixer;
        this.openedDeviceId = deviceId;
        this.captureStartedAt = ctx.currentTime * 1000;

        await this.applySinkId();
        this.vad.start(stream);
        if (processing) this.vad.setThreshold(vadThresholdFor(processing.sensitivity));

        return {ctx, inputGain};
    }

    /** Swap the capture device without touching a single peer connection. See {@link setProcessing}. */
    private async reopenMicrophone(deviceId: string): Promise<void> {
        const ctx = this.ctx;
        const inputGain = this.inputGain;
        if (!ctx || !inputGain) return;

        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: this.constraintsFor(this.processing, deviceId),
                video: false,
            });
        } catch (e) {
            // The old microphone is still connected and still working, so keeping it is strictly
            // better than ending up with none.
            console.error('[voice] could not open the selected microphone; keeping the current one', e);
            return;
        }

        this.micNode?.disconnect();
        for (const track of this.mic?.getTracks() ?? []) track.stop();

        const micNode = ctx.createMediaStreamSource(stream);
        micNode.connect(inputGain);
        this.mic = stream;
        this.micNode = micNode;
        this.openedDeviceId = deviceId;
        // Restarted on the new stream: the gate has to watch the microphone that is actually being
        // published, or it would key on a device the user has stopped using.
        this.vad.start(stream);
        if (this.processing) this.vad.setThreshold(vadThresholdFor(this.processing.sensitivity));
    }

    /**
     * Close the devices once nothing is using them.
     *
     * <p>Separate from {@link stop} because a failed start has to do the same thing, and because the
     * check can only be made after the publication has been removed - the same reason
     * `stop_engine_if_idle` is its own function in Rust.</p>
     */
    private releaseCaptureIfIdle(): void {
        if (this.publications.size > 0) return;

        if (this.levelTimer !== null) clearInterval(this.levelTimer);
        this.levelTimer = null;
        this.vad.stop();
        this.mixer?.clear();
        this.micNode?.disconnect();
        this.inputGain?.disconnect();
        for (const track of this.mic?.getTracks() ?? []) track.stop();
        void this.ctx?.close().catch(() => undefined);

        this.ctx = null;
        this.mic = null;
        this.micNode = null;
        this.inputGain = null;
        this.mixer = null;
        this.openedDeviceId = '';
        this.captureStartedAt = 0;
    }

    private constraintsFor(p: VoiceProcessing | null, deviceId: string): MediaTrackConstraints {
        return {
            // `ideal`, not `exact`: if the microphone vanished between resolution and capture we would
            // rather get the default than fail the whole join.
            deviceId: deviceId ? {ideal: deviceId} : undefined,
            // 'enhanced' is the Rust RNNoise path and has no browser equivalent, so it falls back to
            // the browser's own filter rather than to none - the same direction Rust's unrecognised
            // name falls.
            noiseSuppression: (p?.noiseSuppression ?? 'standard') !== 'none',
            echoCancellation: p?.echoCancellation ?? true,
            autoGainControl: p?.autoGainControl ?? true,
        };
    }

    /**
     * Route the mix to the chosen speaker.
     *
     * <p>Best-effort: `AudioContext.setSinkId` is recent and absent in Safari, where the mix plays on
     * the system default. Reported once rather than silently, because a user who picked an output
     * device and got a different one has no other way to find out.</p>
     */
    private async applySinkId(): Promise<void> {
        const ctx = this.ctx as (AudioContext & {setSinkId?(id: string): Promise<void>}) | null;
        const wanted = this.processing?.outputDeviceId;
        if (!ctx?.setSinkId || !wanted) return;

        try {
            const sinkId = await this.deviceResolver.toWebDeviceId('audiooutput', wanted);
            if (sinkId) await ctx.setSinkId(sinkId);
        } catch (e) {
            console.warn('[voice] could not select the output device; using the system default', e);
        }
    }

    // ── Gate ──────────────────────────────────────────────────────────────────

    /**
     * Whether this publication should be transmitting right now.
     *
     * <p>Three independent facts, and they stay independent: the user has not muted, <i>this call</i>
     * wants the microphone, and the gate says there is speech. Collapsing them would lose the
     * distinction the whole slot design exists for - and it is the reason `stats()` reports the gate
     * per publication rather than once.</p>
     *
     * <p>A gate that is not running counts as <b>open</b>. That is the safe direction: a VAD that
     * failed to start would otherwise leave the user permanently inaudible, which is
     * indistinguishable from a broken microphone, while an over-open gate is at worst audible.</p>
     */
    private gateOpenFor(p: Publication): boolean {
        const speech = this.vad.running() ? this.vad.speaking() : true;
        return !this.muted && p.callerOpen && speech;
    }

    private applyGates(): void {
        for (const publication of this.publications.values()) {
            const open = this.gateOpenFor(publication);
            const gain = publication.gate.gain;
            const now = this.ctx?.currentTime ?? 0;
            try {
                // A 5 ms ramp rather than a step. Keying a hard step onto a live signal is an audible
                // click at both ends, and at speaking rate that is most of what the far end hears.
                gain.cancelScheduledValues(now);
                gain.setValueAtTime(gain.value, now);
                gain.linearRampToValueAtTime(open ? 1 : 0, now + 0.005);
            } catch {
                gain.value = open ? 1 : 0;
            }
            // Mirrored onto the track, which is what a remote peer observes as the publication being
            // live. The gain above is what makes it silent; this is what makes it *say* so.
            publication.track.enabled = open;
        }
    }

    // ── Negotiation ───────────────────────────────────────────────────────────

    private enqueue<T>(p: Publication, op: () => Promise<T>): Promise<T> {
        // The chain is kept settled, or one rejected subscribe takes every later operation on this
        // publication with it.
        const next = p.negotiation.catch(() => undefined).then(op);
        p.negotiation = next.catch(() => undefined);
        return next;
    }

    private async pull(p: Publication, id: string, mediaSessionId: string, trackName: string): Promise<void> {
        // "Already subscribed" needs a route as well as a source. Re-pulling a healthy one would add a
        // second transceiver and mix the participant in twice - but a source with no mid pointing at it
        // is not a subscription, it is the wreckage of one, and every packet the SFU sends for it is
        // dropped. Answering success for that state is what made it permanent: the caller records a
        // subscription it does not have, and every later announcement is skipped as a duplicate.
        if (this.mixer?.has(id)) {
            if (routesTo(p.mids, id)) return;
            console.warn(`[voice] source ${id} has no mid route - re-pulling rather than reporting it subscribed`);
            this.drop(p, id);
        }

        const transceiver = p.pc.addTransceiver('audio', {direction: 'recvonly'});
        p.subscribed.add(id);

        try {
            const offer = await p.pc.createOffer();
            await p.pc.setLocalDescription(offer);

            const response = await p.signalling.subscribe(
                p.mediaSessionId,
                {type: 'offer', sdp: p.pc.localDescription?.sdp ?? offer.sdp ?? ''},
                [{trackName, sessionId: mediaSessionId}],
            );

            const failure = trackError(response.tracks);
            if (failure) throw new Error(`the SFU refused the pull for ${id}: ${failure}`);

            const mid = response.tracks?.[0]?.mid;
            // A track that comes back without a mid is a failed subscribe wearing an HTTP 200. Those
            // mids are the only way to route incoming packets to a participant, so this is reported
            // rather than skipped - skipping it silently is what left a participant unhearable for a
            // whole session with nothing in any log.
            if (!mid) throw new Error(`the SFU returned no mid for ${id}`);

            // Before the answer, never after. See the note on subscribe().
            p.mids.set(mid, id);
            await p.pc.setRemoteDescription(response.sessionDescription as RTCSessionDescriptionInit);

            if (response.requiresImmediateRenegotiation) await this.renegotiate(p);
        } catch (e) {
            // Rolled back, or a failed subscribe leaves a permanently silent participant in the mix
            // and blocks every retry with the "already subscribed" guard above.
            this.drop(p, id);
            // Stopping is the most that can be done: JSEP has no way to take an m-line back out of a
            // session that has already offered it. A stopped one is offered as inactive and can be
            // recycled, which keeps a retried subscribe from growing the SDP without bound.
            try {
                transceiver.stop();
            } catch { /* already stopped, or the connection is gone */
            }
            // Rethrown unchanged, deliberately. `isStaleSubscription` and `isDeadMediaSession` read
            // the `HttpErrorResponse`'s status and body, and wrapping this in a new Error would turn a
            // 409 the caller must answer with a snapshot refetch into a plain failure it retries -
            // which is the loop those two functions exist to break.
            throw e;
        }
    }

    private drop(p: Publication, id: string): void {
        this.mixer?.remove(id);
        p.subscribed.delete(id);
        for (const [mid, sourceId] of [...p.mids]) if (sourceId === id) p.mids.delete(mid);
        for (const [trackId, sourceId] of [...p.trackSources]) {
            if (sourceId === id) p.trackSources.delete(trackId);
        }
        // Their position goes; their volume stays. A slider the user moved is a preference that should
        // survive a rejoin, while a position for somebody who has left is stale the moment they go.
        this.positions.delete(id);
    }

    private async renegotiate(p: Publication): Promise<void> {
        const offer = await p.pc.createOffer();
        await p.pc.setLocalDescription(offer);
        const response = await p.signalling.renegotiate(
            p.mediaSessionId,
            {type: 'offer', sdp: p.pc.localDescription?.sdp ?? offer.sdp ?? ''},
        );
        await p.pc.setRemoteDescription(response.sessionDescription as RTCSessionDescriptionInit);
    }

    /**
     * A remote track opening, matched to the participant it belongs to.
     *
     * <p>An unroutable track is <b>counted</b>, not just ignored. This is where a mid-mapping fault
     * turns into silence: the track opens, the connection is healthy, and every layer above reports
     * success while the audio goes nowhere.</p>
     */
    private route(p: Publication, event: RTCTrackEvent): void {
        const mid = event.transceiver.mid;
        const id = mid ? p.mids.get(mid) : undefined;
        if (!id) {
            p.counters.unroutableTracks++;
            console.error('[voice] a remote track opened on an unmapped mid; its audio cannot be routed', {
                slot: p.slot, mid, routes: [...p.mids],
            });
            return;
        }

        p.counters.tracksOpened++;
        p.trackSources.set(event.track.id, id);
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        this.mixer?.add(id, stream);
        // Re-applied, because both arrive independently of the subscribe - see {@link volumes}.
        this.mixer?.setVolume(id, this.volumes.get(id) ?? 1);
        const position = this.positions.get(id);
        if (position !== undefined) this.mixer?.setPosition(id, position);
    }

    private async teardown(p: Publication): Promise<void> {
        for (const id of [...p.subscribed]) this.drop(p, id);
        // Server-side first, while the session still exists: closing the track is what tells the
        // backend to stop offering it to joiners, and a closed peer connection cannot be asked.
        await p.signalling.closeTracks(p.mediaSessionId, [p.trackName]).catch(() => undefined);
        p.pc.ontrack = null;
        p.pc.close();
        p.gate.disconnect();
        p.destination.disconnect();
    }

    // ── Reporting ─────────────────────────────────────────────────────────────

    private startLevelReports(): void {
        if (this.levelTimer !== null) return;
        // A timer rather than requestAnimationFrame, for the reason `voice-activity.service.ts` gives:
        // a hidden tab gets no animation frames at all, and "hidden" is the normal case for a client
        // whose user is looking at a game.
        this.levelTimer = setInterval(() => this.report(), REMOTE_LEVEL_INTERVAL_MS);
    }

    private report(): void {
        const levels = this.mixer?.poll() ?? [];
        // Only when there is something to report, matching the Rust playout thread: a `levels` event
        // carrying an empty array on every tick is traffic that says nothing.
        if (levels.length > 0) {
            this.broadcast({kind: 'levels', speaking: false, level: 0, levelDb: 0, thresholdDb: 0, levels});
        }
        this.emitSpeaking(this.vad.speaking());
    }

    private emitSpeaking(speaking: boolean): void {
        const level = this.vad.level();
        this.broadcast({
            kind: 'speaking',
            speaking,
            level,
            levelDb: dbfs(level),
            thresholdDb: dbfs(this.vad.threshold()),
        });
    }

    /**
     * Every publication's listener gets every event.
     *
     * <p>Matching `broadcast` in `session.rs`: there is one microphone and one mixer, so the speaking
     * state and the remote levels are engine-wide facts. A publication-scoped event stream would have
     * to decide which call a shared level belongs to, and there is no answer.</p>
     */
    private broadcast(event: VoicePublisherEvent): void {
        for (const publication of this.publications.values()) publication.onEvent?.(event);
    }

    /**
     * One `getStats` pass, split into what belongs to the publication and what belongs to each source.
     *
     * <p>`rtpRouted` is attributed through the track identity recorded when the track opened, which is
     * the only join available here between "packets arrived" and "a participant received them". What is
     * left over is `rtpUnmapped`, and it is the number that separates a subscribe that never delivered
     * from one whose audio is being thrown away.</p>
     */
    private async readStats(p: Publication): Promise<{
        publication: PublicationStats;
        sources: SourceStats[];
        framesCaptured: number;
    }> {
        let packetsSent = 0;
        let rtpReceived = 0;
        let rtpRouted = 0;
        let framesCaptured = 0;
        const sources: SourceStats[] = [];

        try {
            const report = await p.pc.getStats();
            report.forEach(entry => {
                const stat = entry as Record<string, unknown>;
                const type = stat['type'];

                if (type === 'outbound-rtp' && stat['kind'] === 'audio') {
                    packetsSent += numberOf(stat['packetsSent']);
                } else if (type === 'inbound-rtp' && stat['kind'] === 'audio') {
                    const packets = numberOf(stat['packetsReceived']);
                    rtpReceived += packets;
                    const id = p.trackSources.get(String(stat['trackIdentifier'] ?? ''));
                    if (id !== undefined) {
                        rtpRouted += packets;
                        sources.push({id, level: 0, bufferedPackets: bufferedPacketsFrom(stat)});
                    }
                } else if (type === 'media-source' && stat['kind'] === 'audio') {
                    // Seconds of audio the device has produced, as 10 ms frames. Zero with a live call
                    // means the input device is producing nothing whatever the settings page shows.
                    framesCaptured = Math.round(numberOf(stat['totalSamplesDuration']) * 100);
                }
            });
        } catch (e) {
            console.warn('[voice] could not read transport stats', e);
        }

        return {
            publication: {
                slot: p.slot,
                mediaSessionId: p.mediaSessionId,
                trackName: p.trackName,
                open: this.gateOpenFor(p),
                peerState: p.pc.connectionState,
                iceState: p.pc.iceConnectionState,
                packetsSent,
                // No browser equivalent: the Rust counter measures a bounded queue between the capture
                // thread and the writer task, and there is no such hop here - the encoder reads the
                // graph directly. Reported as zero rather than omitted, because the field is part of
                // the shape every stats reader already knows.
                packetsDropped: 0,
                writeErrors: 0,
                tracksOpened: p.counters.tracksOpened,
                rtpReceived,
                rtpRouted,
                rtpUnmapped: Math.max(0, rtpReceived - rtpRouted),
                subscribed: [...p.subscribed].sort(),
                midRoutes: [...p.mids].sort((a, b) => a[0].localeCompare(b[0])),
                localCandidates: candidatesIn(p.pc.localDescription?.sdp ?? ''),
            },
            sources,
            framesCaptured,
        };
    }
}

function clampGain(value: number): number {
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

/** A 0.0-1.0 RMS as dBFS, floored where the meter's scale ends. */
function dbfs(level: number): number {
    if (!Number.isFinite(level) || level <= 0) return SILENCE_DBFS;
    return Math.max(SILENCE_DBFS, 20 * Math.log10(level));
}

/**
 * Jitter-buffer depth in packets, from the delay the browser reports.
 *
 * <p>`jitterBufferDelay` is cumulative seconds across `jitterBufferEmittedCount` samples, so the
 * quotient is the current average hold time; dividing by one 20 ms packet expresses it in the same
 * unit Rust's `bufferedPackets` uses. It is what separates "this participant is subscribed but nothing
 * is arriving" from "packets arrive and decode to silence", which look identical from a level of
 * zero.</p>
 */
function bufferedPacketsFrom(stat: Record<string, unknown>): number {
    const delay = numberOf(stat['jitterBufferDelay']);
    const emitted = numberOf(stat['jitterBufferEmittedCount']);
    if (emitted <= 0) return 0;
    // Emitted count is in samples at 48 kHz; the delay is seconds accumulated per sample.
    const seconds = delay / emitted;
    return Math.max(0, Math.round(seconds / 0.02));
}

function numberOf(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The `candidate:` lines this side offered.
 *
 * <p>The one thing that distinguishes the two ways ICE fails here. This connection is configured with
 * no STUN or TURN servers on the argument that the SFU is publicly routable and will answer to
 * whatever source address it sees - which holds only if our checks reach it at all. Host-only
 * candidates and a failed connection means that argument did not hold on this network; candidates
 * present and still failing means something is dropping the traffic.</p>
 */
function candidatesIn(sdp: string): string[] {
    return sdp.split(/\r\n|\n/)
        .filter(line => line.startsWith('a=candidate:'))
        .map(line => line.slice('a='.length));
}
