/**
 * Browser playout: the distance curve, the placement, and the graph they are applied through.
 *
 * <p>Two halves. The first pins the arithmetic against `mixer.rs`, because on desktop these numbers
 * come out of Rust and on web out of this file, and a proximity peer has to be at the same level and in
 * the same place on both - "spatial audio sounds different on web" is a bug nobody would file usefully.
 * The second builds a real graph against a fake `AudioContext` and asserts <b>what the gains actually
 * end up as</b>, which is the only way to catch the failure this design is most exposed to: a source
 * that is panned correctly and never attenuated, or attenuated and never audible.</p>
 *
 * <p>Each assertion below was checked by mutating the thing it guards - the notes say which.</p>
 */
import {
    DEFAULT_SPATIAL_MODEL,
    distanceGainFor,
    panFor,
    REMOTE_LEVEL_ATTACK,
    REMOTE_LEVEL_FRAMES_PER_POLL,
    REMOTE_SPEAKING_THRESHOLD,
    smoothLevel,
    validateSpatialModel,
    VoiceMixer,
} from './voice-mixer';
import type {SpatialModel} from '../ports/voice-publisher.port';

const model = (patch: Partial<SpatialModel> = {}): SpatialModel => ({...DEFAULT_SPATIAL_MODEL, ...patch});

describe('the distance curve', () => {
    it('is unity out to the reference distance', () => {
        const m = model({refDistance: 5, maxDistance: 40});
        expect(distanceGainFor(m, 0)).toBe(1);
        expect(distanceGainFor(m, 5)).toBe(1);
    });

    it('reaches exactly zero at the audible edge', () => {
        // The renormalisation, and the reason it exists. An un-shifted inverse curve is still around
        // -18 dB at maxDistance - clearly audible - and the backend hands over peers well past that
        // radius, so without the shift a player would vanish abruptly instead of fading out.
        // Mutated by returning `raw` unshifted: this drops to ~0.12 and the test fails.
        const m = model({refDistance: 1, rolloff: 1.6, maxDistance: 20});
        expect(distanceGainFor(m, 20)).toBe(0);
        expect(distanceGainFor(m, 25)).toBe(0);
        expect(distanceGainFor(m, 19.9)).toBeGreaterThan(0);
        expect(distanceGainFor(m, 19.9)).toBeLessThan(0.02);
    });

    it('falls monotonically in between', () => {
        const m = model({refDistance: 1, maxDistance: 40});
        let previous = 1;
        for (let d = 2; d < 40; d += 2) {
            const gain = distanceGainFor(m, d);
            expect(gain).toBeLessThan(previous);
            previous = gain;
        }
    });

    it('silences a source at a nonsensical distance rather than amplifying it', () => {
        // A NaN distance reaching the gain would put NaN in the graph, and one NaN sample silences
        // every participant at once rather than only the one it came from.
        expect(distanceGainFor(model(), Number.NaN)).toBe(0);
        expect(distanceGainFor(model(), Number.POSITIVE_INFINITY)).toBe(0);
    });

    it('survives the flat curve a rolloff of zero produces', () => {
        // rolloff 0 puts the edge value at 1.0, which makes the shift a division by zero. It is a dev
        // knob rather than a setting, but a NaN gain from it would be indistinguishable from the mixer
        // having died.
        const gain = distanceGainFor(model({rolloff: 0, refDistance: 1, maxDistance: 20}), 10);
        expect(Number.isFinite(gain)).toBe(true);
        expect(gain).toBe(1);
    });
});

describe('a spatial model', () => {
    it('rejects the values that would silence every placed source at once', () => {
        // Which looks exactly like the game having stopped sending positions, so it is refused rather
        // than half-applied - the caller learns its tuning was ignored.
        for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(validateSpatialModel(model({maxDistance: bad}))).toBeNull();
        }
        expect(validateSpatialModel(model({refDistance: -1}))).toBeNull();
        expect(validateSpatialModel(model({rolloff: -1}))).toBeNull();
        expect(validateSpatialModel(model({intensity: Number.NaN}))).toBeNull();
    });

    it('pulls a reference distance back inside the audible edge', () => {
        // At or past the edge, every source is either full volume or silent with nothing in between.
        const validated = validateSpatialModel(model({refDistance: 50, maxDistance: 40}));
        expect(validated?.refDistance).toBeCloseTo(39.6, 5);
    });

    it('clamps intensity rather than refusing it', () => {
        expect(validateSpatialModel(model({intensity: 4}))?.intensity).toBe(1);
        expect(validateSpatialModel(model({intensity: -1}))?.intensity).toBe(0);
    });
});

describe('placement', () => {
    it('pans by the lateral component alone', () => {
        expect(panFor({x: 5, y: 0, z: 0})).toBe(1);
        expect(panFor({x: -5, y: 0, z: 0})).toBe(-1);
        expect(panFor({x: 0, y: 0, z: 5})).toBe(0);
    });

    it('centres a source standing on the listener instead of dividing by zero', () => {
        // A NaN pan would silence the whole graph, not just this source.
        expect(panFor({x: 0, y: 0, z: 0})).toBe(0);
    });

    it('pans a diagonal partway', () => {
        const pan = panFor({x: 3, y: 0, z: 4});
        expect(pan).toBeCloseTo(0.6, 5);
    });
});

describe('the remote level smoother', () => {
    it('rises faster than it falls', () => {
        // So the speaking indicator does not flicker between syllables, and does not lag a word.
        const up = smoothLevel(0, 1, REMOTE_LEVEL_FRAMES_PER_POLL);
        const down = 1 - smoothLevel(1, 0, REMOTE_LEVEL_FRAMES_PER_POLL);
        expect(up).toBeGreaterThan(down);
    });

    it('reaches a speaking level within one poll of real speech', () => {
        expect(smoothLevel(0, 0.2, REMOTE_LEVEL_FRAMES_PER_POLL)).toBeGreaterThan(REMOTE_SPEAKING_THRESHOLD);
    });

    it('compounds the coefficient across the frames one poll covers', () => {
        // This is polled every 100 ms while Rust smooths every 10 ms, so the per-frame coefficient has
        // to be compounded over the ten frames a poll stands for. Applying it once instead leaves the
        // attack four times slower in wall time than the desktop indicator, which reads as lag.
        //
        // Asserted against the ten-frame value rather than against the speaking threshold: an attack of
        // 0.4 applied once already clears that threshold, so the obvious test passes with the
        // compounding deleted. It is the *distance* travelled in one poll that carries the property.
        expect(smoothLevel(0, 1, REMOTE_LEVEL_FRAMES_PER_POLL)).toBeGreaterThan(0.9);
        expect(smoothLevel(0, 1, 1)).toBeCloseTo(REMOTE_LEVEL_ATTACK, 6);
        // And the release, from the other side, where the same mistake makes the indicator flicker.
        expect(smoothLevel(1, 0, REMOTE_LEVEL_FRAMES_PER_POLL)).toBeLessThan(0.7);
    });

    it('does not drop below the speaking threshold on one quiet window', () => {
        expect(smoothLevel(0.2, 0, REMOTE_LEVEL_FRAMES_PER_POLL)).toBeGreaterThan(REMOTE_SPEAKING_THRESHOLD);
    });
});

// ── The graph ────────────────────────────────────────────────────────────────

/**
 * A remote stream, as one arrives from `ontrack`.
 *
 * <p>jsdom has no `MediaStream` and no media element stack. The mixer only ever hands the stream to
 * `createMediaStreamSource` and to an `<audio>` element it mutes, so a shape with the two accessors is
 * all it needs - and it is the fake `AudioContext` below that decides what the graph looks like.</p>
 */
function remoteStream(): MediaStream {
    return {getAudioTracks: () => [], getTracks: () => []} as unknown as MediaStream;
}

class FakeParam {
    value = 0;
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
        // A square wave of amplitude a has an RMS of exactly a, so the level is nameable.
        for (let i = 0; i < buffer.length; i++) buffer[i] = i % 2 === 0 ? this.amplitude : -this.amplitude;
    }
}

/**
 * Records every node it makes, in order, so a test can name the one it means.
 *
 * Order is the contract here: `add` creates userGain, distance, dry, wet in that sequence, which is
 * how the assertions below reach the gain that carries the distance attenuation.
 */
class FakeAudioContext {
    currentTime = 0;
    readonly destination = new FakeNode();
    readonly gains: FakeGain[] = [];
    readonly panners: FakePanner[] = [];
    readonly analysers: FakeAnalyser[] = [];

    createGain(): FakeGain {
        const gain = new FakeGain();
        gain.gain.value = 1;
        this.gains.push(gain);
        return gain;
    }

    createStereoPanner(): FakePanner {
        const panner = new FakePanner();
        this.panners.push(panner);
        return panner;
    }

    createAnalyser(): FakeAnalyser {
        const analyser = new FakeAnalyser();
        this.analysers.push(analyser);
        return analyser;
    }

    createMediaStreamSource(): FakeNode {
        return new FakeNode();
    }

    close = vi.fn().mockResolvedValue(undefined);
}

/** The four gains `add` creates, in creation order. `master` is the very first, from the constructor. */
interface Graph {
    master: FakeGain;
    userGain: FakeGain;
    distance: FakeGain;
    dry: FakeGain;
    wet: FakeGain;
    panner: FakePanner;
}

function graphOf(ctx: FakeAudioContext): Graph {
    const [master, userGain, distance, dry, wet] = ctx.gains;
    return {master, userGain, distance, dry, wet, panner: ctx.panners[0]};
}

describe('the mix graph', () => {
    let ctx: FakeAudioContext;
    let mixer: VoiceMixer;

    beforeEach(() => {
        // jsdom has no media element stack; the mixer only needs the element to exist and to accept a
        // stream, and it guards `play()` returning undefined.
        ctx = new FakeAudioContext();
        mixer = new VoiceMixer(ctx as unknown as AudioContext);
        mixer.add('user_a', remoteStream());
    });

    it('centres an unplaced source at full volume', () => {
        // A guild or DM participant is never placed, and a proximity peer the game has not placed yet
        // is in the same mix. Attenuating either would silence a normal call.
        const g = graphOf(ctx);
        expect(g.distance.gain.value).toBe(1);
        expect(g.dry.gain.value).toBe(1);
        expect(g.wet.gain.value).toBe(0);
        expect(g.panner.pan.value).toBe(0);
    });

    it('attenuates and pans a placed source', () => {
        mixer.setSpatialModel({refDistance: 1, rolloff: 1.6, maxDistance: 20, intensity: 1});
        mixer.setPosition('user_a', {x: 10, y: 0, z: 0});

        const g = graphOf(ctx);
        expect(g.distance.gain.value).toBeCloseTo(distanceGainFor(
            {refDistance: 1, rolloff: 1.6, maxDistance: 20, intensity: 1}, 10), 6);
        expect(g.distance.gain.value).toBeLessThan(0.2);
        expect(g.panner.pan.value).toBe(1);
        expect(g.wet.gain.value).toBe(1);
        expect(g.dry.gain.value).toBe(0);
    });

    it('keeps distance and drops direction at intensity zero', () => {
        // This is what "spatial audio off" means, and it is the assertion that fails if the dry/wet
        // split is dropped for a plain "don't pan": the source would go back to full volume however
        // far away it is. Mutated by setting distance.gain to 1 on the dry path - fails here.
        mixer.setSpatialModel({refDistance: 1, rolloff: 1.6, maxDistance: 20, intensity: 0});
        mixer.setPosition('user_a', {x: 10, y: 0, z: 0});

        const g = graphOf(ctx);
        expect(g.dry.gain.value).toBe(1);
        expect(g.wet.gain.value).toBe(0);
        expect(g.distance.gain.value).toBeLessThan(0.2);
    });

    it('re-places every source when the model changes, not only the next one to move', () => {
        // Isle sets the model once on connect and positions on every tick, so a model applied only on
        // the next move would leave whoever is standing still at the old curve.
        mixer.setPosition('user_a', {x: 0, y: 0, z: 10});
        const before = graphOf(ctx).distance.gain.value;
        mixer.setSpatialModel({refDistance: 1, rolloff: 1.6, maxDistance: 100, intensity: 1});
        expect(graphOf(ctx).distance.gain.value).toBeGreaterThan(before);
    });

    it('refuses a model that would silence the mix', () => {
        expect(() => mixer.setSpatialModel({refDistance: 1, rolloff: 1.6, maxDistance: 0, intensity: 1}))
            .toThrow();
    });

    it('applies per-source volume to that source alone', () => {
        mixer.add('user_b', remoteStream());
        mixer.setVolume('user_a', 0.25);

        expect(graphOf(ctx).userGain.gain.value).toBe(0.25);
        // user_b's own gain is the fifth created by its `add`; it must be untouched.
        expect(ctx.gains[5].gain.value).toBe(1);
    });

    it('silences the master while deafened and restores the output volume after', () => {
        // Deafen is output only - the capture chain is untouched, so it still does not stop you
        // transmitting. And the volume underneath has to survive it, or un-deafening arrives silent.
        mixer.setOutputVolume(0.5);
        mixer.setDeafened(true);
        expect(graphOf(ctx).master.gain.value).toBe(0);
        mixer.setDeafened(false);
        expect(graphOf(ctx).master.gain.value).toBe(0.5);
    });

    it('reports a speaking source and a quiet one apart', () => {
        // Per source, because an aggregate cannot tell "everyone is audible" from "one of them is
        // not": one talker's packets read as a healthy connection while a second sits silent.
        mixer.add('user_b', remoteStream());
        ctx.analysers[1].amplitude = 0.2;
        ctx.analysers[2].amplitude = 0;

        // Two polls, because the smoother starts from zero.
        mixer.poll();
        const levels = mixer.poll();

        expect(levels.find(l => l.id === 'user_a')?.speaking).toBe(true);
        expect(levels.find(l => l.id === 'user_b')?.speaking).toBe(false);
    });

    it('stops reporting a source it has dropped', () => {
        // A source left connected is still summed on every render quantum - silently, and forever.
        mixer.remove('user_a');
        expect(mixer.has('user_a')).toBe(false);
        expect(mixer.poll()).toEqual([]);
        expect(graphOf(ctx).userGain.disconnect).toHaveBeenCalled();
    });

    it('replaces a source announced again rather than mixing it in twice', () => {
        // A participant on a corrected session arrives here a second time.
        mixer.add('user_a', remoteStream());
        expect(mixer.ids()).toEqual(['user_a']);
        expect(mixer.poll()).toHaveLength(1);
    });
});
