import {effect, inject, Injectable, untracked} from '@angular/core';
import {HttpClient} from '@angular/common/http';
// Nothing else may be imported from `src/app/services` here: a cycle would leave a module-scope
// constant `undefined` and the capture gate stuck open.
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
import {DEFAULT_SPATIAL_MODEL, REMOTE_LEVEL_INTERVAL_MS, VoiceMixer} from './voice-mixer';
import {trackError, VOICE_TRACK_NAME, VoiceSignalling} from './voice-signalling';
import {applySimpleBitrate, VOICE_AUDIO_KBPS} from '../../services/webrtc-encoding';

/** A real WebRTC microphone publisher, for the browser. */

/**
 * The strictest and most permissive cutoffs the sensitivity slider maps onto, in dBFS. Must stay
 * literal rather than imported from `VAD_METER_FLOOR_DB`; the spec asserts the two are equal.
 */
export const VAD_THRESHOLD_STRICT_DB = -14;
export const VAD_THRESHOLD_OPEN_DB = -60;

/** The capture gate's cutoff, from the engine's 0.0-1.0 sensitivity. Linear in dB, not amplitude. */
export function vadThresholdFor(sensitivity: number): number {
    const clamped = Number.isFinite(sensitivity) ? Math.min(1, Math.max(0, sensitivity)) : 1;
    const db = VAD_THRESHOLD_STRICT_DB + clamped * (VAD_THRESHOLD_OPEN_DB - VAD_THRESHOLD_STRICT_DB);
    return Math.pow(10, db / 20);
}

/** Which slot a target occupies. Mirrors `slot_for` in `media::voice`. */
export function slotFor(target: VoiceTarget): string {
    return target.kind === 'isle' ? 'isle' : 'primary';
}

/** Whether a publication should be routed audio the moment it starts. Always true on web. */
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
    /** The audible gate for this publication: 0 or 1, ramped so keying does not click. */
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

    /** Volumes and positions for sources that may not be pulled yet; both arrive out of order. */
    private readonly volumes = new Map<string, number>();
    private readonly positions = new Map<string, Position['position']>();

    private levelTimer: ReturnType<typeof setInterval> | null = null;
    /** Reported so a caller can tell an idle engine from a broken one. See {@link stats}. */
    private captureStartedAt = 0;

    constructor() {
        super();
        // Only `speaking()` may be tracked here; reading `level()` would re-run this effect 50x a second.
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
        // Must come before the peer connection, so an unavailable microphone reports as one.
        const {ctx, inputGain} = await this.ensureCapture();

        const signalling = new VoiceSignalling(this.http, o.apiBase, o.target);
        const slot = slotFor(o.target);

        // Per-publication tap off the shared capture: a gain, not a cloned track, so gating one
        // publication cannot gate any other.
        const gate = ctx.createGain();
        const destination = ctx.createMediaStreamDestination();
        inputGain.connect(gate);
        gate.connect(destination);
        const track = destination.stream.getAudioTracks()[0];
        if (!track) {
            gate.disconnect();
            throw new Error('the browser produced no audio track for the microphone');
        }

        // No ICE servers: the SFU is publicly routable. `max-bundle` keeps every subscribe on one transport.
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

            // Every track, not only the first: a 200 whose track failed leaves a silent publisher.
            const failure = trackError(response.tracks);
            if (failure) throw new Error(`the SFU rejected the microphone track: ${failure}`);

            await pc.setRemoteDescription(response.sessionDescription as RTCSessionDescriptionInit);

            const connected: Publication = {
                ...publication,
                mediaSessionId,
                trackName: response.tracks?.[0]?.trackName ?? VOICE_TRACK_NAME,
            };
            // Must be re-pointed at the registered record, or a pulled track routes into a discarded map.
            pc.ontrack = event => this.route(connected, event);

            if (response.requiresImmediateRenegotiation) await this.renegotiate(connected);
            // Must run after the answer: the sender has no parameters to set until it is negotiated.
            await applySimpleBitrate(sender, VOICE_AUDIO_KBPS);

            // The previous publication is torn down only here, so a failed rejoin leaves the live call alone.
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
            // Close the devices again if nothing else wanted them.
            this.releaseCaptureIfIdle();
            throw e;
        }
    }

    async stop(s: VoiceSession): Promise<void> {
        const publication = this.publications.get(s.slot);
        // Must match the session as well as the slot, or a late stop tears down its successor.
        if (!publication || publication.mediaSessionId !== s.mediaSessionId) return;
        this.publications.delete(s.slot);
        await this.teardown(publication);
        this.releaseCaptureIfIdle();
    }

    // ── Subscription ──────────────────────────────────────────────────────────

    /**
     * Pull one participant's audio into the mix. The mid-to-source mapping must be written before
     * the answer is applied, or `ontrack` fires with no route and the track is lost.
     */
    subscribe(s: VoiceSession, id: string, mediaSessionId: string, trackName: string): Promise<void> {
        const publication = this.publications.get(s.slot);
        if (!publication) return Promise.reject(new Error(`no voice session is running for ${s.slot}`));
        return this.enqueue(publication, () => this.pull(publication, id, mediaSessionId, trackName));
    }

    /** Take a participant out of the mix. Local only: there is no "unpull" on this SFU. */
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

    /** Mute the microphone itself, for every call at once. Gated, never removed from the sender. */
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
     * Capture processing, mapped onto what a browser actually exposes. The input device is the one
     * setting `applyConstraints` cannot change, so a device change reopens the microphone.
     */
    async setProcessing(p: VoiceProcessing): Promise<void> {
        this.processing = p;

        this.outputVolume = clampGain(p.outputVolume);
        this.mixer?.setOutputVolume(this.outputVolume);
        if (this.inputGain) this.inputGain.gain.value = clampGain(p.inputVolume);
        this.vad.setThreshold(vadThresholdFor(p.sensitivity));

        if (!this.mic) return;

        // The output device too, not only the input: both are chosen in the same settings page.
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
            // A browser that refuses one of these keeps the previous setting.
            console.warn('[voice] the browser refused the capture constraints', e);
        }
    }

    // ── Spatial ───────────────────────────────────────────────────────────────

    async setSpatialModel(m: SpatialModel): Promise<void> {
        // Must be stored before the mixer call, so a publication starting later inherits it.
        this.spatialModel = m;
        this.mixer?.setSpatialModel(m);
    }

    async setPosition(p: Position): Promise<void> {
        this.positions.set(p.id, p.position);
        this.mixer?.setPosition(p.id, p.position);
    }

    // ── Diagnostics ───────────────────────────────────────────────────────────

    /** Every counter this pipeline has, per publication and per source. Zeroed rather than null when idle. */
    async stats(): Promise<VoiceStats> {
        const publications: PublicationStats[] = [];
        const sourceLevels = new Map(this.mixer?.report().map(s => [s.id, s.level]) ?? []);
        const sources: SourceStats[] = [];

        let framesCaptured = 0;
        let packetsEncoded = 0;

        for (const publication of [...this.publications.values()].sort((a, b) =>
            a.slot.localeCompare(b.slot),
        )) {
            const read = await this.readStats(publication);
            publications.push(read.publication);
            // Gauges of one shared capture, so the largest reading rather than a sum.
            framesCaptured = Math.max(framesCaptured, read.framesCaptured);
            packetsEncoded = Math.max(packetsEncoded, read.publication.packetsSent);
            for (const source of read.sources) {
                sources.push({...source, level: sourceLevels.get(source.id) ?? source.level});
            }
        }

        // Sources in the mix that no publication reported on: pulled, but with nothing arriving.
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
            // Render quanta the graph has produced, as 10 ms frames, the same unit Rust reports.
            playoutFrames: this.ctx
                ? Math.round(Math.max(0, this.ctx.currentTime * 1000 - this.captureStartedAt) / 10)
                : 0,
            mixRms: this.mixer?.mixRms() ?? 0,
            deafened: this.deafened,
            masterVolume: this.outputVolume,
            sources,
            publications,
        };
    }

    // ── Capture ───────────────────────────────────────────────────────────────

    /** Open the microphone and the shared graph, once. The VAD must watch the raw capture stream. */
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
        // Resumed even though it is normally already running: a suspended context renders nothing.
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
            // The old microphone still works, so keep it rather than ending up with none.
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
        // Must restart on the new stream, or the gate keys on a device that is no longer published.
        this.vad.start(stream);
        if (this.processing) this.vad.setThreshold(vadThresholdFor(this.processing.sensitivity));
    }

    /** Close the devices once nothing is using them. Callable only after the publication is removed. */
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
            // `ideal`, never `exact`: a vanished microphone must not fail the whole join.
            deviceId: deviceId ? {ideal: deviceId} : undefined,
            // 'enhanced' is the Rust RNNoise path, so it falls back to the browser's own filter.
            noiseSuppression: (p?.noiseSuppression ?? 'standard') !== 'none',
            echoCancellation: p?.echoCancellation ?? true,
            autoGainControl: p?.autoGainControl ?? true,
        };
    }

    /** Route the mix to the chosen speaker. Best-effort: `setSinkId` is absent in Safari. */
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

    /** Whether this publication should be transmitting now. A VAD that is not running counts as open. */
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
                // A 5 ms ramp rather than a step; a hard step on a live signal clicks audibly.
                gain.cancelScheduledValues(now);
                gain.setValueAtTime(gain.value, now);
                gain.linearRampToValueAtTime(open ? 1 : 0, now + 0.005);
            } catch {
                gain.value = open ? 1 : 0;
            }
            // Mirrored onto the track, which is what a remote peer observes as the publication being live.
            publication.track.enabled = open;
        }
    }

    // ── Negotiation ───────────────────────────────────────────────────────────

    private enqueue<T>(p: Publication, op: () => Promise<T>): Promise<T> {
        // The chain must stay settled, or one rejected subscribe takes every later operation with it.
        const next = p.negotiation.catch(() => undefined).then(op);
        p.negotiation = next.catch(() => undefined);
        return next;
    }

    private async pull(p: Publication, id: string, mediaSessionId: string, trackName: string): Promise<void> {
        // "Already subscribed" needs a route as well as a source; a source with no mid is not a
        // subscription, and reporting one as subscribed makes the fault permanent.
        if (this.mixer?.has(id)) {
            if (routesTo(p.mids, id)) return;
            console.warn(
                `[voice] source ${id} has no mid route - re-pulling rather than reporting it subscribed`,
            );
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
            // A track that comes back without a mid is a failed subscribe wearing an HTTP 200.
            if (!mid) throw new Error(`the SFU returned no mid for ${id}`);

            // Before the answer, never after. See the note on subscribe().
            p.mids.set(mid, id);
            await p.pc.setRemoteDescription(response.sessionDescription as RTCSessionDescriptionInit);

            if (response.requiresImmediateRenegotiation) await this.renegotiate(p);
        } catch (e) {
            // Must roll back, or the "already subscribed" guard above blocks every retry.
            this.drop(p, id);
            // Stopping is the most JSEP allows; a stopped transceiver can be recycled.
            try {
                transceiver.stop();
            } catch {
                /* already stopped, or the connection is gone */
            }
            // Must rethrow unchanged: `isStaleSubscription` and `isDeadMediaSession` read the
            // `HttpErrorResponse` status and body.
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
        // Their position goes; their volume stays, so a moved slider survives a rejoin.
        this.positions.delete(id);
    }

    private async renegotiate(p: Publication): Promise<void> {
        const offer = await p.pc.createOffer();
        await p.pc.setLocalDescription(offer);
        const response = await p.signalling.renegotiate(p.mediaSessionId, {
            type: 'offer',
            sdp: p.pc.localDescription?.sdp ?? offer.sdp ?? '',
        });
        await p.pc.setRemoteDescription(response.sessionDescription as RTCSessionDescriptionInit);
    }

    /** A remote track opening, matched to the participant it belongs to. Unroutable tracks are counted. */
    private route(p: Publication, event: RTCTrackEvent): void {
        const mid = event.transceiver.mid;
        const id = mid ? p.mids.get(mid) : undefined;
        if (!id) {
            p.counters.unroutableTracks++;
            console.error('[voice] a remote track opened on an unmapped mid; its audio cannot be routed', {
                slot: p.slot,
                mid,
                routes: [...p.mids],
            });
            return;
        }

        p.counters.tracksOpened++;
        p.trackSources.set(event.track.id, id);
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        this.mixer?.add(id, stream);
        // Re-applied, because both arrive independently of the subscribe. See {@link volumes}.
        this.mixer?.setVolume(id, this.volumes.get(id) ?? 1);
        const position = this.positions.get(id);
        if (position !== undefined) this.mixer?.setPosition(id, position);
    }

    private async teardown(p: Publication): Promise<void> {
        for (const id of [...p.subscribed]) this.drop(p, id);
        // Must close server-side first, while the session still exists; a closed peer cannot be asked.
        await p.signalling.closeTracks(p.mediaSessionId, [p.trackName]).catch(() => undefined);
        p.pc.ontrack = null;
        p.pc.close();
        p.gate.disconnect();
        p.destination.disconnect();
    }

    // ── Reporting ─────────────────────────────────────────────────────────────

    private startLevelReports(): void {
        if (this.levelTimer !== null) return;
        // Must be a timer, not requestAnimationFrame: a hidden tab gets no animation frames.
        this.levelTimer = setInterval(() => this.report(), REMOTE_LEVEL_INTERVAL_MS);
    }

    private report(): void {
        const levels = this.mixer?.poll() ?? [];
        // Only when there is something to report; an empty `levels` event says nothing.
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

    /** Every publication's listener gets every event: speaking state and levels are engine-wide facts. */
    private broadcast(event: VoicePublisherEvent): void {
        for (const publication of this.publications.values()) publication.onEvent?.(event);
    }

    /** One `getStats` pass, split into what belongs to the publication and what belongs to each source. */
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
                    // Seconds of audio the device has produced, as 10 ms frames.
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
                // No browser equivalent, so reported as zero rather than omitted.
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

/** Jitter-buffer depth in packets, from the delay the browser reports. */
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

/** The `candidate:` lines this side offered. */
function candidatesIn(sdp: string): string[] {
    return sdp
        .split(/\r\n|\n/)
        .filter(line => line.startsWith('a=candidate:'))
        .map(line => line.slice('a='.length));
}
