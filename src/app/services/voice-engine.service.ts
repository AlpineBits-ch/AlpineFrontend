import {computed, effect, inject, Injectable, signal} from '@angular/core';
import {SILENCE_DBFS, VoiceProcessing, VoicePublisher} from '../platform/ports/voice-publisher.port';
import {AudioSettings, AudioSettingsService} from './audio-settings.service';

/** Which call surface the session belongs to. Mirrors the Rust `VoiceTarget`. */
export type VoiceTarget =
    | {kind: 'guild'; guildId: string; channelId: string}
    | {kind: 'call'; callId: string}
    | {kind: 'isle'};

/**
 * A running publication - one peer connection to one SFU session.
 *
 * Returned by {@link VoiceEngineService.start} and handed back to every call that addresses it.
 * `slot` is Rust's name for the publication and is deliberately opaque here: the frontend never
 * constructs one, so it cannot address a call that does not exist or, worse, the wrong one.
 *
 * A guild channel and a DM call share a slot, because they are mutually exclusive; Isle proximity
 * voice gets its own and runs alongside either.
 */
export interface VoiceSession {
    readonly slot: string;
    readonly mediaSessionId: string;
    readonly trackName: string;
}

/** A participant's position relative to the listener: +x right, +y up, +z forward, in metres. */
export interface VoicePosition {
    x: number;
    y: number;
    z: number;
}

/**
 * How placed sources fall off with distance, and how hard they are panned. All distances in metres.
 *
 * Mirrors the Rust `SpatialModel`. Only proximity voice sets it; guild and DM participants are never
 * placed, so none of this reaches them.
 */
export interface SpatialModel {
    /** Full volume within this many metres. */
    refDistance: number;
    /** Steepness of the falloff beyond `refDistance`. */
    rolloff: number;
    /** Beyond this many metres a source is silent. */
    maxDistance: number;
    /**
     * How much of a placed source is panned rather than centred, 0-1.
     *
     * Short of 1 on purpose: full HRTF makes a source at 90 degrees almost ear-exclusive, which in
     * a game turns proximity chat into a direction finder. 0 is how the user's "spatial audio off"
     * setting is honoured - direction goes, distance stays.
     */
    intensity: number;
}

/** One remote participant's meter, mirroring the Rust `RemoteLevel`. */
export interface RemoteLevel {
    id: string;
    level: number;
    speaking: boolean;
}

/** One publication's transport counters. Mirrors the Rust `PublicationReport`. */
export interface PublicationStats {
    slot: string;
    mediaSessionId: string;
    trackName: string;
    open: boolean;
    peerState: string;
    iceState: string;
    packetsSent: number;
    packetsDropped: number;
    writeErrors: number;
    tracksOpened: number;
    rtpReceived: number;
    rtpRouted: number;
    rtpUnmapped: number;
    subscribed: string[];
    midRoutes: [string, string][];
    localCandidates: string[];
}

/** One remote participant as the mixer sees them. Mirrors the Rust `SourceReport`. */
export interface SourceStats {
    id: string;
    level: number;
    bufferedPackets: number;
}

/** Mirrors the Rust `VoiceStats`. */
export interface VoiceStats {
    running: boolean;
    framesCaptured: number;
    captureRms: number;
    packetsEncoded: number;
    muted: boolean;
    gateOpen: boolean;
    playoutFrames: number;
    mixRms: number;
    deafened: boolean;
    masterVolume: number;
    sources: SourceStats[];
    publications: PublicationStats[];
}

/**
 * A 0-100 slider position as a 0.0-1.0 gain.
 *
 * Guards the value rather than trusting it: these come from persisted settings, and a corrupted or
 * absent entry that arrives as NaN would multiply a whole frame to NaN in Rust - silencing either
 * the microphone or every remote participant until the next rejoin. Rust clamps again on receipt;
 * this keeps the bad value from being sent at all.
 */
function asGain(percent: number): number {
    return Number.isFinite(percent) ? Math.min(1, Math.max(0, percent / 100)) : 1;
}

/**
 * The bottom of the meter's scale, and what a level reads before any audio has arrived.
 *
 * <p>Re-exported rather than declared: it moved to the port, because both adapters need it and neither
 * may import a value from this service - see the note on {@link SILENCE_DBFS} there. Kept on this path
 * so `voice-video-settings.component.ts` and anything else reading it need no change.</p>
 */
export {SILENCE_DBFS};

/**
 * A 0-100 cutoff slider position as the engine's 0.0-1.0 sensitivity, which runs the other way.
 *
 * A broken value falls back to the *permissive* end - cutoff 0, sensitivity 1.0, the gate switched
 * off. {@link asGain} cannot be reused here even though the arithmetic looks identical: its
 * fallback of 1 means "full volume", and through this inversion that becomes "only transmit a
 * shout" - silencing the microphone on precisely the corrupted-settings case the guard exists for.
 */
function asSensitivity(threshold: number): number {
    return 1 - (Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold / 100)) : 0);
}

/**
 * The Angular face of the audio engine, whichever host is behind it.
 *
 * Every call service talks to this rather than to the {@link VoicePublisher} port directly, so the
 * fact that there is exactly one microphone and one set of speakers is enforced in one place -
 * however many calls are running on top of them.
 *
 * The split between the methods that take a {@link VoiceSession} and those that do not is the whole
 * model: a session addresses one call, everything else addresses the hardware. Muting the
 * microphone is not something you do to a call.
 *
 * <p>Since the browser port this is a <b>delegate</b> over the port: the Rust engine on the desktop
 * host, a `getUserMedia` + `RTCPeerConnection` publisher in a browser. The public surface is
 * unchanged, deliberately - `call-webrtc.service.ts`, `voice-rtc.service.ts`, `voice-channel.service.ts`
 * and `isle-voice-rtc.service.ts` all consume it, and holding it still is what let the port land
 * without a cross-cutting rename. What is *not* delegated is everything below: the slot bookkeeping,
 * the signals the UI reads, and the settings vocabulary. Those are the same on both hosts, so an
 * adapter that had to reimplement them would be two chances to get them wrong.</p>
 */
@Injectable({providedIn: 'root'})
export class VoiceEngineService {
    private readonly audioSettings = inject(AudioSettingsService);
    private readonly publisher = inject(VoicePublisher);

    /**
     * Whether the local user is currently transmitting.
     *
     * The only speaking signal in the app. It replaces the two independent VAD `AudioContext`s,
     * which disagreed with each other and with the gate that actually decided what was sent. There
     * is one microphone, so this is engine-wide rather than per call.
     */
    readonly speaking = signal(false);
    /** Input level, 0.0-1.0, for the microphone meter. */
    readonly level = signal(0);
    /**
     * Input level in dBFS, and the level the gate is currently opening at.
     *
     * Both come from the engine rather than being derived here. The cutoff is relative to the room's
     * own noise floor, so there is nothing in the slider position alone from which the frontend
     * could work out where the line goes.
     */
    readonly levelDb = signal(SILENCE_DBFS);
    readonly thresholdDb = signal(SILENCE_DBFS);

    /**
     * Slots with a call running on them, and the session occupying each.
     *
     * The sessions are held rather than only their slot names because {@link stopAll} has to name
     * each one: the port ends one publication at a time, and a slot string is not something a caller
     * may construct - see {@link VoiceSession.slot}.
     */
    private readonly runningSessions = signal<ReadonlyMap<string, VoiceSession>>(new Map());
    /** Whether any call is running at all - the engine holds the devices open exactly this long. */
    readonly active = computed(() => this.runningSessions().size > 0);

    /**
     * Source ids pulled onto each slot, so stopping one call clears its meters and leaves any
     * other call's participants alone. Rust keeps the authoritative version; this exists only to
     * keep {@link remoteLevels} honest without waiting for the next levels event.
     */
    private readonly subscribedBySlot = new Map<string, Set<string>>();

    /**
     * Every remote participant's meter, keyed by source id.
     *
     * The only remote speaking signal once playout moves to Rust: there are no `<audio>` elements
     * left for the webview to analyse, and this comes from the same decoded frames that reach the
     * speakers, so it cannot disagree with what is audible.
     *
     * Shared across calls, because ids are unique across calls and there is one mixer producing
     * them. A guild participant and a proximity peer are both just entries here.
     */
    private readonly remoteLevelsSignal = signal<ReadonlyMap<string, RemoteLevel>>(new Map());
    readonly remoteLevels = this.remoteLevelsSignal.asReadonly();

    constructor() {
        // Push settings changes at the publisher. Without this the audio settings page would appear
        // to work and change nothing until the next rejoin - and the input-mode switch in particular
        // would be silently dead, because the gate that reads it lives below this line.
        //
        // Pushed whether or not a call is running, unlike before, because the adapter is now the one
        // that knows what to do with settings it cannot apply yet: the Tauri adapter holds them for
        // the `voice_start` that opens the devices with them, and the web adapter applies the ones
        // that do not need a running capture. It also deduplicates, so an unchanged payload costs
        // nothing - which matters, because pushing an unchanged config into a live Rust engine
        // reopens or closes every publication according to the gate mode.
        effect(() => {
            void this.publisher.setProcessing(this.payloadFrom(this.audioSettings.settings()));
        });

        // A page reload does not unwind a native engine. Without this it keeps capturing and
        // publishing into the channel after the webview that started it is gone - audible to
        // everyone else, invisible here, and emitting events at a callback id that no longer
        // exists ("[TAURI] Couldn't find callback id ...").
        //
        // Registered on both hosts. A browser tab tears its own peer connections down on unload, so
        // this is belt and braces there - but it is also what closes the tracks *server-side*, which
        // is the difference between the room being told we left and the room waiting for the sweep.
        window.addEventListener('beforeunload', () => {
            if (this.active()) void this.stopAll();
        });
    }

    /**
     * Whether publishing a microphone is possible at all.
     *
     * True on both hosts now: this used to be `isTauri()`, because outside Tauri there was no engine
     * and every command was a no-op. A browser has a real publisher, so a caller that skipped voice
     * on the strength of this would be skipping a working feature.
     */
    available(): boolean {
        return true;
    }

    /**
     * A snapshot of every counter in the pipeline.
     *
     * For diagnosing the failure mode where the call signals correctly and carries no audio: each
     * stage reports success to the one above it, so the only way to find the break is to look at
     * what actually moved between them. Read two of these a second apart - the deltas are the
     * signal, the totals are not. See `__voiceStats()` in `debug.ts`.
     *
     * Still typed nullable, because callers already handle null and the port cannot make them stop.
     * It no longer *returns* null: both adapters answer with `running: false` and zeroed counters
     * when nothing is up, which is a different fact from "there is no engine on this host" and is
     * the one a reader can act on.
     */
    async stats(): Promise<VoiceStats | null> {
        return await this.publisher.stats();
    }

    /**
     * `apiBase`, `token` and `deviceId` are passed in rather than read here, matching how the
     * screen publisher is called. Rust owns neither session lifetime nor token refresh.
     *
     * `deviceId` must be the same value the webview's `X-Device-Id` header carries: this is the
     * *primary* session, so a mismatch splits one user across two device buckets with their
     * microphone in the wrong one.
     */
    async start(
        target: VoiceTarget,
        apiBase: string,
        token: string,
        deviceId: string,
        /**
         * The SFU connection this publication publishes on - see {@link VoiceStartOptions.livekit}.
         *
         * <p><b>Absent means Isle</b>, which keeps the Cloudflare surface. It cannot mean "guild or
         * call without a connection": the route that path would use no longer exists, so omitting
         * it there is a 404 three layers down rather than an error here. Typed optional only
         * because proximity voice is a real caller with nothing to pass.</p>
         */
        livekit?: {url: string; token: string},
    ): Promise<VoiceSession> {
        // Before the start, not inside it. The port's `start` carries no settings, and both adapters
        // need them by then: `voice_start` opens the devices with them and chooses the gate mode that
        // decides whether a fresh publication starts open, and the web adapter opens `getUserMedia`
        // with the constraints they carry. Awaited so the push cannot land after the start it is for.
        await this.publisher.setProcessing(this.settingsPayload());

        const session = await this.publisher.start({
            target,
            apiBase,
            token,
            deviceId,
            livekit,
            onEvent: event => {
                if (event.kind === 'error') {
                    console.error('[voice] engine error:', event.message);
                    return;
                }
                if (event.kind === 'levels') {
                    this.remoteLevelsSignal.set(new Map((event.levels ?? []).map(l => [l.id, l])));
                    return;
                }
                this.speaking.set(event.speaking);
                this.level.set(event.level);
                this.levelDb.set(event.levelDb ?? SILENCE_DBFS);
                this.thresholdDb.set(event.thresholdDb ?? SILENCE_DBFS);
            },
        });

        // Rejoining the same slot replaces whatever was there, in the adapter and here alike.
        this.subscribedBySlot.set(session.slot, new Set());
        this.runningSessions.update(sessions => new Map(sessions).set(session.slot, session));
        return session;
    }

    /** End one call. Every other call, and the microphone itself, keeps running. */
    async stop(session: VoiceSession): Promise<void> {
        this.forgetSlot(session.slot);
        await this.publisher.stop(session);
    }

    /**
     * End every call at once.
     *
     * For a page reload, where the webview that started them is gone and there is nobody left to
     * name them individually. Ordinary hang-ups use {@link stop}.
     *
     * One stop per publication rather than the slotless `voice_stop`, because the port addresses one
     * session at a time. The end state is the same either way - the engine closes its devices once
     * the last publication goes, in `stop_engine_if_idle` - and they are issued together rather than
     * in sequence, because this runs during unload and each has to get onto the wire.
     */
    async stopAll(): Promise<void> {
        const sessions = [...this.runningSessions().values()];
        this.subscribedBySlot.clear();
        this.runningSessions.set(new Map());
        this.speaking.set(false);
        this.level.set(0);
        this.remoteLevelsSignal.set(new Map());
        await Promise.all(sessions.map(session => this.publisher.stop(session)));
    }

    /**
     * Pull a participant's audio into the mix.
     *
     * `id` is the key for volume, levels and unsubscribe, and is unique across calls - which is
     * what lets one mixer serve them all. Voice uses the user id; a stream's audio uses its track
     * name, so that muting someone's stream does not also mute their voice.
     *
     * Rejects rather than resolving quietly on failure - nothing retries a subscribe, so a swallowed
     * error here is a participant who stays silent for the rest of the session.
     */
    async subscribe(
        session: VoiceSession,
        id: string,
        mediaSessionId: string,
        trackName: string,
    ): Promise<void> {
        this.subscribedBySlot.get(session.slot)?.add(id);
        await this.publisher.subscribe(session, id, mediaSessionId, trackName);
    }

    async unsubscribe(session: VoiceSession, id: string): Promise<void> {
        this.subscribedBySlot.get(session.slot)?.delete(id);
        this.dropLevel(id);
        await this.publisher.unsubscribe(session, id);
    }

    /**
     * Open or close the microphone *for one call*.
     *
     * Per call, not engine-wide: proximity push-to-talk must not also key the guild channel. The
     * microphone is captured once and stays live while any call wants it; this decides who hears it.
     */
    async setPttOpen(session: VoiceSession, open: boolean): Promise<void> {
        await this.publisher.setPttOpen(session, open);
    }

    /**
     * Mute the microphone itself, for every call at once.
     *
     * Engine-wide unlike push-to-talk, because muting is a statement about the microphone rather
     * than about a conversation - a mute that left you audible somewhere else would be the worst
     * possible way to discover that calls are separate.
     */
    async setMute(muted: boolean): Promise<void> {
        await this.publisher.setMute(muted);
    }

    /** Per-source volume, 0.0-1.0. */
    async setUserVolume(id: string, volume: number): Promise<void> {
        await this.publisher.setUserVolume(id, volume);
    }

    async setDeafened(deafened: boolean): Promise<void> {
        await this.publisher.setDeafened(deafened);
    }

    // ── Positional audio (Isle proximity voice) ───────────────────────────────

    /**
     * How placed sources fall off with distance, and how hard they are panned.
     *
     * `maxDistance` has to match the radius the backend uses to decide who is subscribed at all -
     * otherwise players either fade out before they stop being sent, or stay at full volume until
     * they abruptly vanish. The rest is the tuning the WebAudio graph used before mixing moved into
     * Rust, passed through unchanged so proximity voice sounds the same rather than merely working.
     *
     * Rejects if the numbers would silence the mix, rather than half-applying them.
     */
    async setSpatialModel(model: SpatialModel): Promise<void> {
        await this.publisher.setSpatialModel(model);
    }

    /**
     * Move a participant, or un-place them by passing null.
     *
     * Listener-relative: the caller has already applied the listener's own position and facing.
     * Called on every movement tick, so it deliberately does nothing but forward - Rust keeps the
     * table and the playout thread picks up changes once per frame.
     *
     * This is also the only spatial switch there is. Turning proximity audio off means un-placing
     * every peer, not clearing a mode flag: one mixer serves the guild call and Isle at the same
     * time, so a flag would have had to be right for both at once. A source with no position is
     * centred at full volume, which is exactly what a guild participant wants.
     */
    async setPosition(id: string, position: VoicePosition | null): Promise<void> {
        // The spec's `setPosition` takes one argument and no participant id, which cannot address the
        // per-source position table the mixer keeps - so the id travels inside it. This signature is
        // the one every caller already has.
        await this.publisher.setPosition({id, position});
    }

    /** Push the current settings to the engine. Safe to call when nothing is running. */
    async applySettings(): Promise<void> {
        await this.publisher.setProcessing(this.settingsPayload());
    }

    /** Drop a slot's local bookkeeping, including the meters of everyone who was on it. */
    private forgetSlot(slot: string): void {
        for (const id of this.subscribedBySlot.get(slot) ?? []) this.dropLevel(id);
        this.subscribedBySlot.delete(slot);
        this.runningSessions.update(sessions => {
            if (!sessions.has(slot)) return sessions;
            const next = new Map(sessions);
            next.delete(slot);
            return next;
        });
        if (!this.active()) {
            this.speaking.set(false);
            this.level.set(0);
            this.levelDb.set(SILENCE_DBFS);
        }
    }

    private dropLevel(id: string): void {
        this.remoteLevelsSignal.update(m => {
            if (!m.has(id)) return m;
            const n = new Map(m);
            n.delete(id);
            return n;
        });
    }

    /**
     * Field names here must match the Rust `VoiceSettings` exactly - it is deserialised by name, so
     * a mismatch is a setting that silently stops working rather than an error anyone sees.
     */
    private settingsPayload(): VoiceProcessing {
        return this.payloadFrom(this.audioSettings.settings());
    }

    /**
     * Typed as {@link VoiceProcessing} rather than left inferred, so a field renamed here is a
     * compile error instead of a setting that silently stops working - which is what the Rust struct's
     * name-based deserialisation makes of a mismatch.
     */
    private payloadFrom(s: AudioSettings): VoiceProcessing {
        return {
            deviceId: s.micId === 'default' ? null : s.micId,
            // Chosen when the engine opens the device, so like the microphone it takes effect once
            // the last call ends rather than immediately.
            outputDeviceId: s.speakerId === 'default' ? null : s.speakerId,
            noiseSuppression: s.noiseSuppressionMode,
            echoCancellation: s.echoCancellation,
            autoGainControl: s.autoGainControl,
            inputMode: s.inputMode === 'push-to-talk' ? 'ptt' : 'voice',
            // The one place the UI's vocabulary and the engine's meet, and they run opposite ways.
            // `voiceThreshold` is a cutoff - the knob's position on the meter, where left is
            // permissive - because that is the only arrangement in which "the knob is where your
            // voice cuts off" is true. The engine takes a sensitivity, where 1.0 is permissive.
            // Inverted here, once, rather than in the component: a widget that quietly reversed its
            // own model would be invisible to everything that reads the setting.
            //
            // Not `vadStrength`, which is a separate 0-1 control that only applied when enhanced
            // noise suppression was on - sending that one instead would leave the gate at its least
            // sensitive setting by default and cut off anyone speaking quietly.
            sensitivity: asSensitivity(s.voiceThreshold),
            // Both sliders are stored 0-100 and consumed as gains. Until now nothing read either of
            // them: the microphone and output volume controls moved, saved, and changed nothing.
            inputVolume: asGain(s.inputVolume),
            outputVolume: asGain(s.outputVolume),
            bitrateBps: null,
        };
    }
}
