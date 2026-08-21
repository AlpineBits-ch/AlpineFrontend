import type {RemoteLevel, SpatialModel, VoicePosition} from '../ports/voice-publisher.port';

/**
 * The playout half of browser voice: every pulled participant, mixed and placed. One mixer serves
 * every call, since source ids are unique across calls.
 *
 * Per source: source node, userGain, distance, then a dry/wet split into a StereoPannerNode, then
 * master (0 while deafened) into the destination.
 */

/** The level a remote source counts as speaking at, and how its meter is smoothed. */
export const REMOTE_SPEAKING_THRESHOLD = 0.015;
export const REMOTE_LEVEL_ATTACK = 0.4;
export const REMOTE_LEVEL_RELEASE = 0.05;

/** How often every source's meter is read, in milliseconds. Matches Rust's `LEVEL_REPORT_FRAMES`. */
export const REMOTE_LEVEL_INTERVAL_MS = 100;

/** 10 ms frames of smoothing applied per {@link REMOTE_LEVEL_INTERVAL_MS} poll. See {@link smoothLevel}. */
export const REMOTE_LEVEL_FRAMES_PER_POLL = 10;

/** Samples per level window. 1024 at 48 kHz is 21 ms, the same window the capture VAD uses. */
const ANALYSER_FFT_SIZE = 1024;

/**
 * One step of the remote level smoother. `frames` is how many 10 ms frames the step stands in for;
 * the coefficient must be compounded over them to keep attack and release right in wall time.
 */
export function smoothLevel(current: number, target: number, frames: number): number {
    const coefficient = target > current ? REMOTE_LEVEL_ATTACK : REMOTE_LEVEL_RELEASE;
    const compounded = 1 - Math.pow(1 - coefficient, frames);
    return current + (target - current) * compounded;
}

/** Reject a model that would silence or corrupt the mix, rather than half-applying it. */
export function validateSpatialModel(model: SpatialModel): SpatialModel | null {
    const finite = [model.refDistance, model.rolloff, model.maxDistance, model.intensity].every(n =>
        Number.isFinite(n),
    );
    if (!finite || model.maxDistance <= 0 || model.refDistance < 0 || model.rolloff < 0) return null;
    return {
        // A reference distance at or past the audible edge leaves no gradient at all.
        refDistance: Math.min(model.refDistance, model.maxDistance * 0.99),
        rolloff: model.rolloff,
        maxDistance: model.maxDistance,
        intensity: Math.min(1, Math.max(0, model.intensity)),
    };
}

/**
 * Gain for a source `distance` metres away: full volume within `refDistance`, then an inverse curve
 * of steepness `rolloff`, renormalised so it reaches exactly zero at `maxDistance`.
 */
export function distanceGainFor(model: SpatialModel, distance: number): number {
    if (!Number.isFinite(distance)) return 0;
    if (distance <= model.refDistance) return 1;
    if (distance >= model.maxDistance) return 0;

    const curve = (d: number) =>
        model.refDistance / (model.refDistance + model.rolloff * (d - model.refDistance));
    const raw = curve(distance);
    const edge = curve(model.maxDistance);
    // A flat curve (rolloff 0, a dev knob) puts the edge at 1.0 and the shift below undefined.
    if (edge >= 1) return raw;
    return Math.min(1, Math.max(0, (raw - edge) / (1 - edge)));
}

export function distanceOf(position: VoicePosition): number {
    return Math.sqrt(position.x * position.x + position.y * position.y + position.z * position.z);
}

/**
 * Stereo pan for a listener-relative position, -1 (hard left) to 1 (hard right). Must never return
 * NaN: one NaN pan silences the whole graph, not just its own source.
 */
export function panFor(position: VoicePosition): number {
    const distance = distanceOf(position);
    if (!Number.isFinite(distance) || distance <= Number.EPSILON) return 0;
    return Math.min(1, Math.max(-1, position.x / distance));
}

/** The default model, matching Rust's `SpatialModel::default()`. */
export const DEFAULT_SPATIAL_MODEL: SpatialModel = {
    refDistance: 1,
    rolloff: 1.6,
    maxDistance: 20,
    intensity: 1,
};

interface MixerSource {
    /**
     * A muted, playing `<audio>` element holding the same stream. Do not remove it: in Chromium a
     * remote stream fed only into a `MediaStreamAudioSourceNode` stays silent.
     */
    readonly element: HTMLAudioElement;
    readonly node: MediaStreamAudioSourceNode;
    readonly userGain: GainNode;
    readonly distance: GainNode;
    readonly dry: GainNode;
    readonly wet: GainNode;
    readonly panner: StereoPannerNode;
    readonly analyser: AnalyserNode;
    readonly buffer: Float32Array<ArrayBuffer>;
    volume: number;
    position: VoicePosition | null;
    level: number;
}

/** Every remote participant, mixed into one output. The `AudioContext` is owned by the capture side. */
export class VoiceMixer {
    private readonly master: GainNode;
    private readonly sources = new Map<string, MixerSource>();

    private model: SpatialModel = DEFAULT_SPATIAL_MODEL;
    private deafened = false;
    private outputVolume = 1;

    /** Mixed output RMS, for `stats().mixRms`: the number that says the graph is producing sound. */
    private readonly mixAnalyser: AnalyserNode;
    private readonly mixBuffer: Float32Array<ArrayBuffer>;

    constructor(private readonly ctx: AudioContext) {
        this.master = ctx.createGain();
        this.mixAnalyser = ctx.createAnalyser();
        this.mixAnalyser.fftSize = ANALYSER_FFT_SIZE;
        this.mixBuffer = new Float32Array(this.mixAnalyser.fftSize);
        // The analyser is a tap, not a stage: it must never gain a downstream connection.
        this.master.connect(this.mixAnalyser);
        this.master.connect(ctx.destination);
    }

    /** Pull a decoded stream into the mix under `id`, replacing whatever was there. */
    add(id: string, stream: MediaStream): void {
        this.remove(id);

        const element = new Audio();
        element.srcObject = stream;
        element.muted = true;
        element.autoplay = true;
        // The `play()` is what starts the receiver. Guarded on the return value: jsdom and older
        // Safari return undefined, and `.catch` on that is a TypeError.
        const played: unknown = element.play();
        if (played instanceof Promise) void played.catch(() => undefined);

        const node = this.ctx.createMediaStreamSource(stream);
        const userGain = this.ctx.createGain();
        const distance = this.ctx.createGain();
        const dry = this.ctx.createGain();
        const wet = this.ctx.createGain();
        const panner = this.ctx.createStereoPanner();
        const analyser = this.ctx.createAnalyser();
        analyser.fftSize = ANALYSER_FFT_SIZE;

        node.connect(userGain);
        userGain.connect(distance);
        distance.connect(dry);
        distance.connect(wet);
        wet.connect(panner);
        dry.connect(this.master);
        panner.connect(this.master);
        // Must tap before placement, so a distant peer who is talking still lights their dot.
        userGain.connect(analyser);

        const source: MixerSource = {
            element,
            node,
            userGain,
            distance,
            dry,
            wet,
            panner,
            analyser,
            buffer: new Float32Array(analyser.fftSize),
            volume: 1,
            position: null,
            level: 0,
        };
        this.sources.set(id, source);
        this.applyPlacement(source);
    }

    /** Whether `id` is currently in the mix. */
    has(id: string): boolean {
        return this.sources.has(id);
    }

    ids(): string[] {
        return [...this.sources.keys()];
    }

    /**
     * Take a source out of the mix entirely. Every node must be disconnected and the element's
     * stream dropped, or the source is still summed and its receiver stays alive.
     */
    remove(id: string): void {
        const source = this.sources.get(id);
        if (!source) return;
        this.sources.delete(id);
        try {
            source.node.disconnect();
            source.userGain.disconnect();
            source.distance.disconnect();
            source.dry.disconnect();
            source.wet.disconnect();
            source.panner.disconnect();
            source.analyser.disconnect();
        } catch {
            // A context that has already been closed throws here; the source is gone either way.
        }
        source.element.pause();
        source.element.srcObject = null;
    }

    clear(): void {
        for (const id of this.ids()) this.remove(id);
    }

    /** Per-source volume, 0.0-1.0. Remembered even for a source not yet pulled. */
    setVolume(id: string, volume: number): void {
        const clamped = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
        const source = this.sources.get(id);
        if (!source) return;
        source.volume = clamped;
        source.userGain.gain.value = clamped;
    }

    /** Silence everything at once. Output only: deafen does not stop you transmitting. */
    setDeafened(deafened: boolean): void {
        this.deafened = deafened;
        this.master.gain.value = deafened ? 0 : this.outputVolume;
    }

    /** Master output volume, 0.0-1.0. Ignored while deafened, and reapplied when deafen lifts. */
    setOutputVolume(volume: number): void {
        this.outputVolume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
        if (!this.deafened) this.master.gain.value = this.outputVolume;
    }

    /** How placed sources fall off and how hard they are panned. Throws rather than half-apply a model. */
    setSpatialModel(model: SpatialModel): void {
        const validated = validateSpatialModel(model);
        if (!validated) throw new Error(`nonsensical spatial model: ${JSON.stringify(model)}`);
        this.model = validated;
        for (const source of this.sources.values()) this.applyPlacement(source);
    }

    /** Move a participant, or un-place them with null. Positions are listener-relative. */
    setPosition(id: string, position: VoicePosition | null): void {
        const source = this.sources.get(id);
        if (!source) return;
        source.position = position;
        this.applyPlacement(source);
    }

    /** RMS of the most recent mixed window. Non-zero here with silence in the room blames the sink. */
    mixRms(): number {
        this.mixAnalyser.getFloatTimeDomainData(this.mixBuffer);
        return rms(this.mixBuffer);
    }

    /** Read every source's meter and advance its smoothing one poll. Per source, never aggregated. */
    poll(): RemoteLevel[] {
        const levels: RemoteLevel[] = [];
        for (const [id, source] of this.sources) {
            source.analyser.getFloatTimeDomainData(source.buffer);
            source.level = smoothLevel(source.level, rms(source.buffer), REMOTE_LEVEL_FRAMES_PER_POLL);
            levels.push({
                id,
                level: source.level,
                speaking: source.level > REMOTE_SPEAKING_THRESHOLD,
            });
        }
        return levels;
    }

    /** What each source contributes right now, for `stats().sources`. */
    report(): {id: string; level: number}[] {
        return [...this.sources.entries()]
            .map(([id, source]) => ({id, level: source.level}))
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    /**
     * The dry/wet split and pan for one source, from its position and the current model. An unplaced
     * source is centred at full volume with no attenuation.
     */
    private applyPlacement(source: MixerSource): void {
        const position = source.position;
        if (!position) {
            source.distance.gain.value = 1;
            source.dry.gain.value = 1;
            source.wet.gain.value = 0;
            source.panner.pan.value = 0;
            return;
        }

        source.distance.gain.value = distanceGainFor(this.model, distanceOf(position));
        source.dry.gain.value = 1 - this.model.intensity;
        source.wet.gain.value = this.model.intensity;
        source.panner.pan.value = panFor(position);
    }
}

function rms(buffer: Float32Array): number {
    let sum = 0;
    for (const sample of buffer) sum += sample * sample;
    return Math.sqrt(sum / buffer.length);
}
