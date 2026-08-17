import {computed, Injectable, signal} from '@angular/core';

/**
 * Open-mic gate for the browser client.
 *
 * <p>On desktop the microphone is opened by a global hotkey, which keeps working while the game has
 * focus because the OS delivers the key to us whether or not our window is in front. A browser tab
 * cannot have that: there is no web API that fires while the tab is unfocused, so push-to-talk in a
 * browser means "push to talk, as long as you are looking at the app instead of the game" - which
 * for Isle proximity voice is no feature at all. Voice activity detection is the substitute, and it
 * is what makes proximity voice usable on the web at all.</p>
 *
 * <p>The graph is deliberately minimal: `MediaStreamAudioSourceNode` -> `AnalyserNode`, and
 * <em>nothing after it</em>. An `AnalyserNode` runs from being fed alone; connecting it onward to
 * `ctx.destination` is a one-line change that turns this into a microphone-to-speakers feedback
 * loop, so the absence of that connection is asserted in the spec rather than left to memory.</p>
 *
 * <p>The stream is passed in and never opened here. The caller owns mic lifetime - the same stream
 * is being published, and a service that called `getUserMedia` itself would either open a second
 * capture of the same device or fight the publisher over who gets to stop it.</p>
 */

/**
 * Samples per analysis window. 1024 at 48 kHz is 21.3 ms of audio.
 *
 * Sized against speech, not against the FFT: this reads the time domain, so the only thing
 * `fftSize` decides here is the window length. One Opus frame is 20 ms and that is not a
 * coincidence - it is the shortest window that still holds two full glottal periods of a low male
 * voice (a 100 Hz fundamental is 10 ms per period), which is what stops the RMS from rising and
 * falling with the pitch cycle itself. Doubling it to 2048 would smear a word onset across 43 ms
 * for no gain in stability; halving it would make the level meter jitter at the speaker's pitch.
 */
export const VAD_FFT_SIZE = 1024;

/**
 * How often the analyser is read, in milliseconds.
 *
 * Chosen so the windows are *contiguous*: an {@link VAD_FFT_SIZE}-sample window is 21.3 ms at
 * 48 kHz, so reading every 20 ms means every millisecond of audio lands in some window. That is the
 * property the attack claim below rests on - at a 50 ms poll we would be looking at 21 ms out of
 * every 50 and a quiet word onset could fall entirely in the 29 ms nobody looked at. 50 reads a
 * second of a 1024-float buffer is not a cost worth optimising against that.
 */
export const VAD_POLL_INTERVAL_MS = 20;

/**
 * How long the level has to stay above the threshold before the gate opens, in milliseconds.
 *
 * This is the number that costs latency at the front of a word, so it is the one to keep small -
 * but not zero. 40 ms is two windows, which means a transient has to survive being seen twice
 * independently. That distinction is the whole point while a game has focus: keyboard clacks, mouse
 * clicks and knocks on the desk are impulses of roughly 5-15 ms that the mic hears through the
 * desk, and each one that opens the gate costs a full {@link VAD_HANGOVER_MS} of open microphone.
 * At one window they get through; at two they do not.
 *
 * 40 ms of onset latency is below what a listener can identify as a clipped consonant, and an order
 * of magnitude under what the path already spends on a 20 ms Opus frame plus a jitter buffer.
 */
export const VAD_ATTACK_MS = 40;

/**
 * How long the level has to stay below the threshold before the gate closes, in milliseconds.
 *
 * Sized against the silences that occur *inside* speech, because cutting one of those is what makes
 * open mic sound like a broken walkie-talkie. A voiceless stop closure - the gap in the middle of
 * "sti/p/ple" - runs 50-120 ms and is genuinely near-silent; a hesitation inside a phrase reaches
 * about 200 ms. 300 ms clears both with margin. It stays well under a between-sentence pause, which
 * is 500 ms and up, so the gate still closes when you actually stop talking.
 *
 * Longer is not free and is not the safe direction: everything after the last word is transmitted,
 * which in proximity voice means the room hears your keyboard and your footsteps give you away.
 */
export const VAD_HANGOVER_MS = 300;

/**
 * The hangover is also at least this many observed poll gaps.
 *
 * This is what keeps the gate honest in a backgrounded tab, and it exists because of the clock this
 * runs on rather than the speech. A hidden page's timers are throttled to about 1 Hz, so a poll can
 * arrive a second late carrying a 21 ms window - a snapshot of an unknown second. Closing the gate
 * on one such window means a single unlucky sample landing in a stop closure cuts the speaker off
 * mid-sentence. Requiring two consecutive starved-and-quiet windows makes that take two unlucky
 * samples in a row.
 *
 * At the normal 20 ms poll this is 40 ms and therefore inert - {@link VAD_HANGOVER_MS} always wins.
 * It only has an effect once the poll gap exceeds 150 ms, which is to say only when something has
 * already gone wrong with our scheduling.
 */
export const VAD_STARVED_HANGOVER_POLLS = 2;

/**
 * Ceiling on the extension above, in milliseconds.
 *
 * Without it, a page under Chromium's *intensive* throttling (one timer wake per minute after five
 * minutes hidden) would hold the gate open for two minutes of "hangover" on a mic nobody is
 * speaking into. Past a couple of seconds the trade has inverted: an open microphone costs more
 * than a chopped sentence, and a page being woken once a minute is not one somebody is holding a
 * conversation through.
 */
export const VAD_MAX_HANGOVER_MS = 2_000;

/**
 * Starting RMS threshold, on the same 0..1 scale as {@link VoiceActivityService.level}.
 *
 * 0.02 is about -34 dBFS. With the browser's own auto-gain on, speech at a normal headset distance
 * lands around -26 to -14 dBFS and a desk noise floor - fans, a room, a distant keyboard - sits
 * around -50 to -40 dBFS, so this is roughly the middle of that gap on the scale that matters,
 * which is the logarithmic one: ~10 dB clear of the noise and ~14 dB below speech.
 *
 * A default, not a setting. The gap between those two numbers moves by 20 dB across microphones, so
 * this is only ever a starting point for the slider and the live meter next to it.
 */
export const VAD_DEFAULT_THRESHOLD = 0.02;

/** Bottom of the meter scale in dBFS. Below this an input is indistinguishable from a dead mic. */
export const VAD_METER_FLOOR_DB = -60;

/**
 * Map an RMS level onto 0..1 for display.
 *
 * A meter driven by linear RMS is useless: speech occupies the bottom fifth of the bar and the
 * default threshold sits at 2% of its width, so neither the level nor the marker for the value the
 * user is dragging ever moves anywhere visible. Exported rather than kept private because the
 * threshold slider has to be drawn in the same space as the level it is being compared against -
 * two different mappings would put the marker somewhere the level never reaches.
 */
export function vadMeterScale(rms: number): number {
    if (rms <= 0) return 0;
    const db = 20 * Math.log10(rms);
    if (db <= VAD_METER_FLOOR_DB) return 0;
    return Math.min(1, db / -VAD_METER_FLOOR_DB + 1);
}

@Injectable({providedIn: 'root'})
export class VoiceActivityService {
    private readonly levelSignal = signal(0);
    /** RMS of the most recent window, 0..1. Unsmoothed - the gate reads this too. */
    readonly level = this.levelSignal.asReadonly();

    private readonly speakingSignal = signal(false);
    /** The gate. True while the microphone should be transmitting. */
    readonly speaking = this.speakingSignal.asReadonly();

    private readonly thresholdSignal = signal(VAD_DEFAULT_THRESHOLD);
    readonly threshold = this.thresholdSignal.asReadonly();

    private readonly runningSignal = signal(false);
    /** Whether a stream is being watched. Drives the settings meter's own visibility. */
    readonly running = this.runningSignal.asReadonly();

    /** {@link level}, mapped for a meter. See {@link vadMeterScale}. */
    readonly meter = computed(() => vadMeterScale(this.level()));

    private ctx: AudioContext | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private analyser: AnalyserNode | null = null;
    /** Reused across polls; `getFloatTimeDomainData` will not take a shared-buffer view. */
    private buffer: Float32Array<ArrayBuffer> | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;

    /**
     * Audio-clock reading of the previous poll, in milliseconds. Anchored at {@link start}, so even
     * the first poll measures a real gap rather than assuming it arrived on time.
     *
     * `AudioContext.currentTime` rather than `performance.now()` or `Date.now()`, because it is the
     * clock the samples themselves arrived on. It cannot jump the way wall time can, and - the
     * reason it is load-bearing here - the difference between it and the poll period is exactly the
     * measurement {@link VAD_STARVED_HANGOVER_POLLS} needs: it says how much audio went by between
     * the window we just looked at and the one before, which a timestamp taken on our own starved
     * timer cannot. A suspended context stops advancing it, and that is correct: no audio is being
     * rendered, so no evidence for or against speech has accumulated.
     */
    private lastPollMs = 0;

    /** Milliseconds of contiguous audio observed above the threshold, and below it. */
    private hotMs = 0;
    private coldMs = 0;

    /** Clamped, because the slider that drives this is user input and the comparison is silent. */
    setThreshold(value: number): void {
        this.thresholdSignal.set(Math.min(1, Math.max(0, value)));
    }

    /**
     * Begin watching a microphone stream.
     *
     * Restarts cleanly if already running - the input device can be changed mid-call, which hands us
     * a new stream for the same session, and leaving the old graph polling would gate on a
     * microphone the user has stopped using.
     */
    start(stream: MediaStream): void {
        this.stop();

        const ctx = new AudioContext();
        // The mic is already open, so autoplay policy is satisfied and this normally starts
        // 'running'; resumed anyway because a context that is suspended renders nothing, which here
        // shows up as a gate that never moves rather than as an error.
        void ctx.resume().catch(e => console.warn('[vad] could not resume the audio context', e));

        const analyser = ctx.createAnalyser();
        analyser.fftSize = VAD_FFT_SIZE;
        const source = ctx.createMediaStreamSource(stream);
        source.connect(analyser);
        // And no further. See the class comment: an AnalyserNode needs no downstream connection, and
        // giving it one routes the microphone to the speakers.

        this.ctx = ctx;
        this.analyser = analyser;
        this.source = source;
        this.buffer = new Float32Array(analyser.fftSize);
        this.lastPollMs = ctx.currentTime * 1000;
        this.hotMs = 0;
        this.coldMs = 0;
        this.runningSignal.set(true);

        // A timer, not `requestAnimationFrame`. rAF is the obvious choice for something that drives
        // a meter, and it is the wrong one here: a hidden tab does not get animation frames at all,
        // so the gate would stop being evaluated and freeze in whichever state it was last in -
        // permanently muted mid-call, or worse, a microphone left open on a room that thinks it has
        // stopped transmitting. And "hidden" is the *normal* case for this feature, since the reason
        // VAD exists at all is that the game, not the tab, has focus. A throttled timer degrades in
        // resolution; a paused rAF loop stops being a gate. `spatial-audio.service.ts` picked the
        // same way for the same reason.
        this.timer = setInterval(() => this.poll(), VAD_POLL_INTERVAL_MS);
    }

    stop(): void {
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        this.source?.disconnect();
        this.analyser?.disconnect();
        // Closed rather than suspended: the caller owns the track, so nothing here is worth keeping
        // warm, and a context left suspended holds an audio thread for the life of the page.
        void this.ctx?.close().catch(() => {
        });
        this.ctx = null;
        this.source = null;
        this.analyser = null;
        this.buffer = null;
        this.lastPollMs = 0;
        // Closed explicitly. Whoever is reading `speaking` is holding a microphone open with it, and
        // leaving it true after teardown leaves that mic open with nothing left running to shut it.
        this.speakingSignal.set(false);
        this.levelSignal.set(0);
        this.runningSignal.set(false);
    }

    private poll(): void {
        const ctx = this.ctx;
        const analyser = this.analyser;
        const buffer = this.buffer;
        if (!ctx || !analyser || !buffer) return;

        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
        const rms = Math.sqrt(sum / buffer.length);
        this.levelSignal.set(rms);

        const nowMs = ctx.currentTime * 1000;
        const gapMs = nowMs - this.lastPollMs;
        this.lastPollMs = nowMs;
        // The audio clock has not moved, so the analyser is handing back the window we already
        // judged. Nothing has been observed and nothing should accumulate.
        if (gapMs <= 0) return;

        if (rms >= this.thresholdSignal()) {
            this.coldMs = 0;
            this.hotMs += gapMs;
            // Evidence is counted in milliseconds of audio rather than in polls, so a starved poll
            // carrying a hot window opens the gate immediately: when a second of audio went by and
            // the one sample we have of it is speech, waiting for a second sample costs another
            // whole second of the sentence.
            if (this.hotMs >= VAD_ATTACK_MS) this.speakingSignal.set(true);
        } else {
            this.hotMs = 0;
            this.coldMs += gapMs;
            if (this.coldMs >= this.hangoverMs(gapMs)) this.speakingSignal.set(false);
        }
    }

    /** See {@link VAD_STARVED_HANGOVER_POLLS} and {@link VAD_MAX_HANGOVER_MS}. */
    private hangoverMs(gapMs: number): number {
        const starved = Math.min(VAD_STARVED_HANGOVER_POLLS * gapMs, VAD_MAX_HANGOVER_MS);
        return Math.max(VAD_HANGOVER_MS, starved);
    }
}
