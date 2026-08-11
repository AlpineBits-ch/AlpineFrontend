import type {RemoteLevel, SpatialModel, VoicePosition} from '../ports/voice-publisher.port';

/**
 * The playout half of browser voice: every pulled participant, mixed and placed.
 *
 * <p>A Web Audio counterpart to `src-tauri/src/media/voice/mixer.rs`. On desktop, remote audio is
 * pulled, decoded, jitter-buffered, mixed and played entirely in Rust - there are no `&lt;audio&gt;`
 * elements left in the webview at all. On web there is no Rust, so this is what stands in, and it has
 * to reproduce four things the app already depends on: per-source volume, deafen, distance
 * attenuation with stereo placement, and a per-source level for the remote speaking indicators.</p>
 *
 * <p><b>One mixer for every call.</b> Source ids are unique across calls, so a guild participant and
 * an Isle proximity peer are both just entries here - exactly as in Rust, and for the same reason:
 * one graph means one output device and one place where "everything you can hear" exists.</p>
 *
 * <h3>The graph, per source</h3>
 *
 * <pre>
 *   MediaStreamAudioSourceNode
 *     -> userGain      per-source volume (the slider)
 *       -> distance    inverse-distance attenuation, 1.0 when unplaced
 *         -> dry       (1 - intensity), centred
 *         -> wet       intensity, through a StereoPannerNode
 *           -> master  output volume, 0 while deafened
 *             -> destination
 * </pre>
 *
 * <p>The dry/wet split is not decoration - it is how `SpatialModel.intensity` is defined, and it is
 * lifted straight from `Mixer::render_spatial`: the centred share is
 * `gain * distanceGain * (1 - intensity)` and the panned share is `gain * distanceGain * intensity`.
 * Intensity 0 is how "spatial audio off" is honoured: direction goes, distance stays. Getting this
 * wrong by simply not panning would leave distant players at full volume, which is the failure that
 * makes proximity voice unusable rather than merely unspatialised.</p>
 *
 * <p><b>Panning is constant power and matches Rust's fallback path exactly.</b>
 * `StereoPannerNode` applies `cos`/`sin` of a quarter turn to a mono input, which is the same law
 * `stereo_pan` implements - so a source at a given position sits at the same place, at the same level,
 * on both hosts. What web does <i>not</i> have is the HRIR convolution desktop uses when the bundled
 * SADIE dataset is present: there is no elevation cue and front cannot be told from back. Left/right
 * placement, which is the cue proximity chat leans on hardest, is identical.</p>
 */

/**
 * The level a remote source counts as speaking at, and how its meter is smoothed.
 *
 * <p>Mirrors `receive.rs`, so a speaking dot lights at the same point on both hosts. Slower to fall
 * than to rise, so the indicator does not flicker between syllables.</p>
 */
export const REMOTE_SPEAKING_THRESHOLD = 0.015;
export const REMOTE_LEVEL_ATTACK = 0.4;
export const REMOTE_LEVEL_RELEASE = 0.05;

/**
 * How often every source's meter is read, in milliseconds.
 *
 * <p>Matches Rust's `LEVEL_REPORT_FRAMES` (10 frames of 10 ms): fast enough for a speaking indicator,
 * and a hundredth of the traffic that reporting per frame would cost.</p>
 */
export const REMOTE_LEVEL_INTERVAL_MS = 100;

/** 10 ms frames of smoothing applied per {@link REMOTE_LEVEL_INTERVAL_MS} poll. See {@link smoothLevel}. */
export const REMOTE_LEVEL_FRAMES_PER_POLL = 10;

/** Samples per level window. 1024 at 48 kHz is 21 ms - the same window the capture VAD uses. */
const ANALYSER_FFT_SIZE = 1024;

/**
 * One step of the remote level smoother.
 *
 * <p>`frames` is how many 10 ms frames the step stands in for, because this is polled every
 * {@link REMOTE_LEVEL_INTERVAL_MS} rather than per frame as Rust is. Compounding the coefficient over
 * that many frames is what keeps the attack and release <i>in wall time</i> the same on both hosts -
 * applying the per-frame coefficient once per poll would make the indicator rise a third of a second
 * late, which reads as lag in the one part of the UI that is judged on immediacy.</p>
 */
export function smoothLevel(current: number, target: number, frames: number): number {
    const coefficient = target > current ? REMOTE_LEVEL_ATTACK : REMOTE_LEVEL_RELEASE;
    const compounded = 1 - Math.pow(1 - coefficient, frames);
    return current + (target - current) * compounded;
}

/**
 * Reject a model that would silence or corrupt the mix, rather than half-applying it.
 *
 * <p>A mirror of `SpatialModel::validated`. `maxDistance` in particular silences every placed source
 * at once, which looks exactly like the game having stopped sending positions.</p>
 */
export function validateSpatialModel(model: SpatialModel): SpatialModel | null {
    const finite = [model.refDistance, model.rolloff, model.maxDistance, model.intensity]
        .every(n => Number.isFinite(n));
    if (!finite || model.maxDistance <= 0 || model.refDistance < 0 || model.rolloff < 0) return null;
    return {
        // A reference distance at or past the audible edge would make every source either full
        // volume or silent, with nothing in between.
        refDistance: Math.min(model.refDistance, model.maxDistance * 0.99),
        rolloff: model.rolloff,
        maxDistance: model.maxDistance,
        intensity: Math.min(1, Math.max(0, model.intensity)),
    };
}

/**
 * Gain for a source `distance` metres away.
 *
 * <p>A mirror of `SpatialModel::gain`: full volume within `refDistance`, then an inverse curve of
 * steepness `rolloff`, renormalised so it reaches exactly zero at `maxDistance`. The renormalisation
 * is the part worth keeping: an un-shifted inverse curve is still audible well past the radius the
 * backend stops sending at, so peers would vanish abruptly instead of fading out.</p>
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
 * Stereo pan for a listener-relative position, -1 (hard left) to 1 (hard right).
 *
 * <p>Only the lateral component: `+x` is the listener's right. Standing on the listener yields 0
 * rather than a division by zero - a NaN here would silence the whole graph, not just one source.</p>
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
     * A muted, playing `<audio>` element holding the same stream.
     *
     * <p>Not decoration and not playback: in Chromium a remote WebRTC `MediaStream` fed only into a
     * `MediaStreamAudioSourceNode` produces <b>silence</b> until the stream is also attached to a
     * media element, because the receiver is not started until something consumes it. It is muted so
     * the element itself contributes nothing - everything audible comes out of the graph below, where
     * the volume and placement live. Removing this is a one-line change that makes every remote
     * participant silent while every counter still says the audio arrived.</p>
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

/**
 * Every remote participant, mixed into one output.
 *
 * <p>The `AudioContext` is passed in rather than created, because the capture side owns one already
 * and a second context is a second audio thread, a second clock, and a second thing to resume after
 * an autoplay block.</p>
 */
export class VoiceMixer {
    private readonly master: GainNode;
    private readonly sources = new Map<string, MixerSource>();

    private model: SpatialModel = DEFAULT_SPATIAL_MODEL;
    private deafened = false;
    private outputVolume = 1;

    /** Mixed output RMS, for `stats().mixRms` - the number that says the graph is producing sound. */
    private readonly mixAnalyser: AnalyserNode;
    private readonly mixBuffer: Float32Array<ArrayBuffer>;

    constructor(private readonly ctx: AudioContext) {
        this.master = ctx.createGain();
        this.mixAnalyser = ctx.createAnalyser();
        this.mixAnalyser.fftSize = ANALYSER_FFT_SIZE;
        this.mixBuffer = new Float32Array(this.mixAnalyser.fftSize);
        // The analyser is a tap, not a stage: it is fed and has no downstream connection, so it
        // cannot alter what reaches the speakers.
        this.master.connect(this.mixAnalyser);
        this.master.connect(ctx.destination);
    }

    /**
     * Pull a decoded stream into the mix under `id`.
     *
     * <p>Replaces whatever was under that id: a participant announced on a corrected session arrives
     * here again, and leaving the old graph connected would mix them in twice.</p>
     */
    add(id: string, stream: MediaStream): void {
        this.remove(id);

        const element = new Audio();
        element.srcObject = stream;
        element.muted = true;
        element.autoplay = true;
        // Best-effort: an autoplay block here costs nothing, because the element is muted and the
        // audible path is the graph. The `play()` is what starts the receiver - see the field note.
        // Guarded on the return value rather than awaited blindly: environments without a real media
        // stack (jsdom, and older Safari) return undefined here, and `.catch` on that is a TypeError
        // that would take the whole subscribe down.
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
        // Tapped before placement, so a source's meter reads what it is contributing rather than how
        // far away it happens to be standing. A distant peer who is talking still lights their dot.
        userGain.connect(analyser);

        const source: MixerSource = {
            element, node, userGain, distance, dry, wet, panner, analyser,
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
     * Take a source out of the mix entirely.
     *
     * <p>Everything is disconnected and the element's stream dropped, because a source left connected
     * is still summed on every render quantum - silently, but forever - and a `<audio>` element still
     * holding a remote stream keeps its receiver alive.</p>
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

    /**
     * Silence everything at once.
     *
     * <p>Output only: the capture chain is untouched, so deafen still does not stop you transmitting.
     * Mute is a separate control, exactly as it is in Rust.</p>
     */
    setDeafened(deafened: boolean): void {
        this.deafened = deafened;
        this.master.gain.value = deafened ? 0 : this.outputVolume;
    }

    /** Master output volume, 0.0-1.0. Ignored while deafened, and reapplied when deafen lifts. */
    setOutputVolume(volume: number): void {
        this.outputVolume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
        if (!this.deafened) this.master.gain.value = this.outputVolume;
    }

    /**
     * How placed sources fall off and how hard they are panned.
     *
     * <p>Rejects a model that would silence the mix rather than half-applying it, and reports that so
     * the caller learns its tuning was ignored instead of wondering why proximity voice sounds
     * unchanged.</p>
     */
    setSpatialModel(model: SpatialModel): void {
        const validated = validateSpatialModel(model);
        if (!validated) throw new Error(`nonsensical spatial model: ${JSON.stringify(model)}`);
        this.model = validated;
        for (const source of this.sources.values()) this.applyPlacement(source);
    }

    /**
     * Move a participant, or un-place them with null.
     *
     * <p>Listener-relative: the caller has already applied the listener's own position and facing.
     * Called on every movement tick, so it does the minimum - two gains and a pan.</p>
     */
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

    /**
     * Read every source's meter and advance its smoothing one poll.
     *
     * <p>Per source, deliberately. An aggregate cannot tell "everyone is audible" from "one of them is
     * not": 300 packets a second from one participant reads as a healthy connection while a second
     * sits silent. This is the number that separates them, and it is measured after gain, which is the
     * only place a participant muted to zero looks different from one who has stopped sending.</p>
     */
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
     * The dry/wet split and pan for one source, from its position and the current model.
     *
     * <p>An unplaced source is centred at full volume with no attenuation - which is exactly what a
     * guild or DM participant wants, and what a proximity peer the game has not placed yet gets.</p>
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
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    return Math.sqrt(sum / buffer.length);
}
