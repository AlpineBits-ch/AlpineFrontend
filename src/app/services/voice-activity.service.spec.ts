/**
 * The open-mic gate, driven by synthetic audio and an explicit clock.
 *
 * Every test here feeds a buffer whose RMS is known exactly and then asserts *when* the gate moved,
 * not merely that it can move: a VAD spec that starts the service and checks a signal exists passes
 * against an implementation with no gate in it at all. The instants asserted below are the reason
 * {@link VAD_ATTACK_MS} and friends are exported - the windows are pinned here rather than described
 * in a comment. Each was checked against a mutation of the thing it guards; see the note on each.
 *
 * Time is driven in two ways, and the difference is the point. {@link pump} advances the audio clock
 * and the timer together, which is a foregrounded tab. {@link starvedPoll} advances the audio clock a
 * long way and then lets exactly one poll run, which is a hidden tab whose timers have been
 * throttled to ~1 Hz - the normal case for this feature, since the whole reason it exists is that
 * the game has focus and this tab does not.
 */
import {TestBed} from '@angular/core/testing';
import {
    VAD_ATTACK_MS,
    VAD_DEFAULT_THRESHOLD,
    VAD_FFT_SIZE,
    VAD_HANGOVER_MS,
    VAD_MAX_HANGOVER_MS,
    VAD_METER_FLOOR_DB,
    VAD_POLL_INTERVAL_MS,
    VAD_STARVED_HANGOVER_POLLS,
    vadMeterScale,
    VoiceActivityService,
} from './voice-activity.service';

/** Amplitudes, in the same 0..1 RMS space as the threshold. */
const SILENCE = 0;
/** ~-14 dBFS. A comfortable speaking level, well clear of {@link VAD_DEFAULT_THRESHOLD}. */
const SPEECH = 0.2;
/** ~-40 dBFS. A desk noise floor: audible, and deliberately below the default threshold. */
const ROOM_NOISE = 0.01;

/**
 * Stands in for the `AnalyserNode`.
 *
 * A square wave alternating +/-a has an RMS of exactly a, so the level the service computes is a
 * value the tests can name rather than approximate. `sine` exists for the one test that checks the
 * RMS maths itself, where an exact-but-trivial waveform would prove nothing.
 */
class FakeAnalyser {
    fftSize = 2048;
    amplitude = SILENCE;
    shape: 'square' | 'sine' = 'square';
    reads = 0;
    readonly connect = vi.fn();
    readonly disconnect = vi.fn();

    getFloatTimeDomainData(buffer: Float32Array): void {
        this.reads++;
        for (let i = 0; i < buffer.length; i++) {
            buffer[i] = this.shape === 'square'
                ? (i % 2 === 0 ? this.amplitude : -this.amplitude)
                // Eight whole cycles across the window, so the RMS is exactly a/sqrt(2).
                : this.amplitude * Math.sin((2 * Math.PI * 8 * i) / buffer.length);
        }
    }
}

class FakeSourceNode {
    readonly connect = vi.fn();
    readonly disconnect = vi.fn();

    constructor(readonly stream: MediaStream) {
    }
}

class FakeAudioContext {
    static instances: FakeAudioContext[] = [];

    readonly destination = {} as AudioDestinationNode;
    readonly analyser = new FakeAnalyser();
    readonly sources: FakeSourceNode[] = [];
    /**
     * Seconds, advanced by the tests. Never by wall time - nothing here waits on anything.
     *
     * Seeded from the tests' own clock rather than from zero, so a context opened part-way through a
     * test (a restart on a new input device) does not appear to rewind time.
     */
    currentTime = clockMs / 1000;
    readonly resume = vi.fn().mockResolvedValue(undefined);
    readonly close = vi.fn().mockResolvedValue(undefined);

    constructor() {
        FakeAudioContext.instances.push(this);
    }

    createAnalyser(): FakeAnalyser {
        return this.analyser;
    }

    createMediaStreamSource(stream: MediaStream): FakeSourceNode {
        const source = new FakeSourceNode(stream);
        this.sources.push(source);
        return source;
    }
}

/** jsdom has no MediaStream and the service only ever hands it to the context. */
const fakeStream = (label = 'mic'): MediaStream => ({label}) as unknown as MediaStream;

let service: VoiceActivityService;
let ctx: FakeAudioContext;
let clockMs: number;
/** Every change of the gate, in the order they happened, with the audio-clock instant of each. */
let transitions: { atMs: number; speaking: boolean }[];
let originalAudioContext: unknown;

beforeEach(() => {
    vi.useFakeTimers();
    FakeAudioContext.instances = [];
    clockMs = 0;
    transitions = [];
    originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;
    (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;

    TestBed.configureTestingModule({});
    service = TestBed.inject(VoiceActivityService);
});

afterEach(() => {
    service.stop();
    vi.useRealTimers();
    (globalThis as { AudioContext?: unknown }).AudioContext = originalAudioContext;
});

function start(stream: MediaStream = fakeStream()): void {
    service.start(stream);
    ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1];
}

function record(): void {
    const speaking = service.speaking();
    const last = transitions[transitions.length - 1]?.speaking ?? false;
    if (speaking !== last) transitions.push({atMs: clockMs, speaking});
}

/**
 * Feed `ms` of audio at `amplitude`, one poll at a time, with the audio clock kept in step.
 *
 * The clock is advanced *before* the timer fires, because that is the order a real poll sees: the
 * window it reads is audio that has already been rendered.
 */
function pump(ms: number, amplitude: number, shape: 'square' | 'sine' = 'square'): void {
    ctx.analyser.amplitude = amplitude;
    ctx.analyser.shape = shape;
    for (let i = 0; i < ms / VAD_POLL_INTERVAL_MS; i++) {
        clockMs += VAD_POLL_INTERVAL_MS;
        ctx.currentTime = clockMs / 1000;
        vi.advanceTimersByTime(VAD_POLL_INTERVAL_MS);
        record();
    }
}

/**
 * A backgrounded tab: `ms` of audio went by and we are woken exactly once to look at 21 ms of it.
 *
 * `advanceTimersToNextTimer` rather than advancing the full span, so the poll count matches a
 * throttled wake instead of firing fifty times against one clock reading.
 */
function starvedPoll(ms: number, amplitude: number): void {
    ctx.analyser.amplitude = amplitude;
    clockMs += ms;
    ctx.currentTime = clockMs / 1000;
    vi.advanceTimersToNextTimer();
    record();
}

describe('VoiceActivityService', () => {
    it('sizes the analysis window to one speech frame', () => {
        start();

        // Not decoration: the window length is what the attack window's contiguity claim rests on.
        expect(ctx.analyser.fftSize).toBe(VAD_FFT_SIZE);
        expect(VAD_FFT_SIZE / 48_000 * 1000).toBeGreaterThan(VAD_POLL_INTERVAL_MS);
    });

    /**
     * Guards the feedback loop. An `AnalyserNode` runs from being fed alone, so connecting it onward
     * is a change that produces no error, no test failure and a howl of microphone-to-speaker
     * feedback for every user. Mutation checked: adding `analyser.connect(ctx.destination)` to
     * `start` fails this and nothing else.
     */
    it('taps the microphone without routing it to the speakers', () => {
        const stream = fakeStream();
        start(stream);

        expect(ctx.sources[0].stream).toBe(stream);
        expect(ctx.sources[0].connect).toHaveBeenCalledWith(ctx.analyser);
        expect(ctx.analyser.connect).not.toHaveBeenCalled();
    });

    it('never opens the gate on silence', () => {
        start();

        pump(1_000, SILENCE);

        expect(service.speaking()).toBe(false);
        expect(service.level()).toBe(0);
        expect(transitions).toEqual([]);
    });

    it('never opens the gate on room noise below the threshold', () => {
        start();

        pump(1_000, ROOM_NOISE);

        expect(service.level()).toBeCloseTo(ROOM_NOISE, 6);
        expect(transitions).toEqual([]);
    });

    /**
     * Mutation checked: opening on the first hot window (`hotMs >= 0`) fails this at the first
     * assertion, and the impulse test below.
     */
    it('opens the gate after the attack window, not on the first window', () => {
        start();

        pump(VAD_ATTACK_MS - VAD_POLL_INTERVAL_MS, SPEECH);
        expect(service.speaking()).toBe(false);

        pump(VAD_POLL_INTERVAL_MS, SPEECH);
        expect(transitions).toEqual([{atMs: VAD_ATTACK_MS, speaking: true}]);
    });

    /**
     * A keyboard clack through the desk is one window wide. Left unfiltered, every keystroke in a
     * game costs a full hangover of open microphone - which is the thing the attack window exists
     * for, so it is asserted rather than assumed.
     */
    it('ignores an impulse shorter than the attack window', () => {
        start();

        pump(VAD_POLL_INTERVAL_MS, SPEECH);
        pump(500, SILENCE);

        expect(transitions).toEqual([]);
    });

    /**
     * The tail of a sentence. A stop closure or a hesitation is a real silence inside speech, and
     * closing across one is what makes open mic sound like a broken radio.
     *
     * Mutation checked: dropping the hangover (closing on the first cold window) fails here.
     */
    it('holds the gate through a pause shorter than the hangover', () => {
        start();
        pump(200, SPEECH);
        const opened = [...transitions];

        pump(VAD_HANGOVER_MS - VAD_POLL_INTERVAL_MS, SILENCE);

        expect(service.speaking()).toBe(true);
        expect(transitions).toEqual(opened);
    });

    it('closes the gate at the hangover boundary once the pause is long enough', () => {
        start();
        pump(200, SPEECH);

        pump(VAD_HANGOVER_MS, SILENCE);

        expect(transitions).toEqual([
            {atMs: VAD_ATTACK_MS, speaking: true},
            {atMs: 200 + VAD_HANGOVER_MS, speaking: false},
        ]);
    });

    it('reopens after closing, so a second sentence is not swallowed', () => {
        start();
        pump(200, SPEECH);
        pump(VAD_HANGOVER_MS, SILENCE);

        pump(VAD_ATTACK_MS, SPEECH);

        expect(transitions.map(t => t.speaking)).toEqual([true, false, true]);
    });

    /**
     * The reason this runs on a timer rather than `requestAnimationFrame`, and the reason the
     * hangover has a floor in *observed poll gaps*.
     *
     * A hidden tab is woken about once a second and hands us a 21 ms window: a snapshot of an
     * unknown second. Acting on one of those closes the gate whenever that sample happens to land in
     * a stop closure, cutting the speaker off mid-word with no way to tell.
     *
     * Mutation checked: replacing `hangoverMs()` with the bare `VAD_HANGOVER_MS` closes the gate on
     * the first starved poll and fails this test alone.
     */
    it('does not chop speech when the tab is backgrounded and polls are starved', () => {
        start();
        pump(VAD_ATTACK_MS, SPEECH);

        // One throttled wake, and the 21 ms it happens to see is quiet.
        starvedPoll(1_000, SILENCE);
        expect(service.speaking()).toBe(true);

        // A second consecutive quiet wake is no longer bad luck.
        starvedPoll(1_000, SILENCE);
        expect(service.speaking()).toBe(false);
        expect(VAD_STARVED_HANGOVER_POLLS).toBe(2);
    });

    /** A starved wake that *does* see speech opens immediately - waiting costs another whole second. */
    it('opens on a single starved poll that carries speech', () => {
        start();

        starvedPoll(1_000, SPEECH);

        expect(service.speaking()).toBe(true);
    });

    /**
     * Intensive throttling: one wake per minute. Extending the hangover by two poll gaps there would
     * hold a microphone open for two minutes.
     *
     * Mutation checked: removing the {@link VAD_MAX_HANGOVER_MS} clamp leaves the gate open here.
     */
    it('caps the starved hangover rather than holding the mic open for minutes', () => {
        start();
        pump(VAD_ATTACK_MS, SPEECH);

        starvedPoll(60_000, SILENCE);

        expect(service.speaking()).toBe(false);
        expect(VAD_MAX_HANGOVER_MS).toBeLessThanOrEqual(2_000);
    });

    it('computes RMS, not peak, from the time-domain window', () => {
        start();

        // A sine of amplitude 0.5 has an RMS of 0.5/sqrt(2). Reading peak would give 0.5, and
        // averaging the raw samples would give ~0.
        pump(VAD_POLL_INTERVAL_MS, 0.5, 'sine');

        expect(service.level()).toBeCloseTo(0.5 / Math.SQRT2, 4);
    });

    it('gates on the threshold that is set, not the default', () => {
        start();
        service.setThreshold(SPEECH * 2);

        pump(500, SPEECH);
        expect(service.speaking()).toBe(false);

        service.setThreshold(SPEECH / 2);
        pump(VAD_ATTACK_MS, SPEECH);
        expect(service.speaking()).toBe(true);
    });

    it('clamps a threshold coming from a slider into 0..1', () => {
        service.setThreshold(-5);
        expect(service.threshold()).toBe(0);

        service.setThreshold(12);
        expect(service.threshold()).toBe(1);
    });

    /**
     * Whoever reads `speaking` is holding a microphone open with it. Leaving it true after teardown
     * leaves that mic open with nothing running that could ever shut it.
     *
     * Mutation checked: dropping `speakingSignal.set(false)` from `stop` fails here; dropping
     * `clearInterval` fails the frozen-reads assertion.
     */
    it('closes the gate and stops polling on stop', () => {
        start();
        pump(VAD_ATTACK_MS, SPEECH);
        expect(service.speaking()).toBe(true);
        const readsAtStop = ctx.analyser.reads;

        service.stop();

        expect(service.speaking()).toBe(false);
        expect(service.level()).toBe(0);
        expect(service.running()).toBe(false);
        expect(ctx.sources[0].disconnect).toHaveBeenCalled();
        expect(ctx.close).toHaveBeenCalled();

        vi.advanceTimersByTime(1_000);
        expect(ctx.analyser.reads).toBe(readsAtStop);
    });

    /**
     * Changing the input device mid-call hands us a new stream for the same session. The old graph
     * has to go, or the gate keeps deciding from a microphone the user stopped using.
     */
    it('restarting on a new stream abandons the old graph', () => {
        start(fakeStream('old'));
        pump(VAD_ATTACK_MS, SPEECH);
        const old = ctx;
        const oldReads = old.analyser.reads;

        const replacement = fakeStream('new');
        start(replacement);
        pump(200, SILENCE);

        expect(FakeAudioContext.instances).toHaveLength(2);
        expect(ctx).not.toBe(old);
        expect(ctx.sources[0].stream).toBe(replacement);
        expect(old.close).toHaveBeenCalled();
        expect(old.analyser.reads).toBe(oldReads);
        // Exactly one read per poll, which is the assertion that catches a *leaked* interval rather
        // than a merely idle one. Checking `reads > 0` here passed with `clearInterval` removed
        // altogether: the abandoned timer survives, and because `stop` nulls the graph it looks
        // harmless - right up to the restart, where the old timer starts polling the new graph and
        // the gate runs at twice the intended rate for the rest of the session.
        expect(ctx.analyser.reads).toBe(200 / VAD_POLL_INTERVAL_MS);
    });

    /** A restart is also a closed gate until the new stream has earned it back. */
    it('restarting closes the gate rather than carrying it over', () => {
        start();
        pump(VAD_ATTACK_MS, SPEECH);

        start(fakeStream('new'));

        expect(service.speaking()).toBe(false);
    });

    describe('meter scale', () => {
        /**
         * The property the mapping exists for: on a linear scale the default threshold sits at 2% of
         * the bar's width, so neither the level nor the marker the user drags ever moves anywhere
         * visible.
         */
        it('puts speaking levels in the visible part of the bar', () => {
            expect(VAD_DEFAULT_THRESHOLD).toBeLessThan(0.05);
            expect(vadMeterScale(VAD_DEFAULT_THRESHOLD)).toBeGreaterThan(0.4);
            expect(vadMeterScale(SPEECH)).toBeGreaterThan(0.7);
        });

        it('spans 0..1 and bottoms out at the floor', () => {
            expect(vadMeterScale(0)).toBe(0);
            expect(vadMeterScale(1)).toBe(1);
            expect(vadMeterScale(10 ** (VAD_METER_FLOOR_DB / 20))).toBe(0);
            expect(vadMeterScale(2)).toBe(1);
        });

        it('is what the level signal is exposed through', () => {
            start();

            pump(VAD_POLL_INTERVAL_MS, SPEECH);

            expect(service.meter()).toBeCloseTo(vadMeterScale(SPEECH), 6);
        });
    });
});
