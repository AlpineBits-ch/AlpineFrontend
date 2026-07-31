import {computed, effect, inject, Injectable, signal} from '@angular/core';
import {Channel, invoke, isTauri} from '@tauri-apps/api/core';
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
    readonly cfSessionId: string;
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

interface VoiceEvent {
    kind: 'speaking' | 'levels' | 'error';
    speaking: boolean;
    level: number;
    message?: string;
    levels?: RemoteLevel[];
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
 * The Angular face of the Rust audio engine.
 *
 * Every call service talks to this rather than calling `invoke` directly, so the fact that there is
 * exactly one microphone and one set of speakers is enforced in one place - however many calls are
 * running on top of them.
 *
 * The split between the methods that take a {@link VoiceSession} and those that do not is the whole
 * model: a session addresses one call, everything else addresses the hardware. Muting the
 * microphone is not something you do to a call.
 */
@Injectable({providedIn: 'root'})
export class VoiceEngineService {
    private readonly audioSettings = inject(AudioSettingsService);

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

    /** Slots with a call running on them. */
    private readonly runningSlots = signal<ReadonlySet<string>>(new Set());
    /** Whether any call is running at all - the engine holds the devices open exactly this long. */
    readonly active = computed(() => this.runningSlots().size > 0);

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
        // Push settings changes into a running session. Without this the audio settings page would
        // appear to work and change nothing until the next rejoin - and the input-mode switch in
        // particular would be silently dead, because the gate that reads it now lives in Rust.
        //
        // The input and output *devices* are the exception: they are chosen when the engine opens
        // them, so switching hardware takes effect once the last call ends and the engine restarts.
        effect(() => {
            const payload = this.payloadFrom(this.audioSettings.settings());
            if (!this.active() || !isTauri()) return;
            void invoke('voice_set_processing', {settings: payload});
        });

        // A page reload does not unwind Rust. Without this the engine keeps capturing and
        // publishing into the channel after the webview that started it is gone - audible to
        // everyone else, invisible here, and emitting events at a callback id that no longer
        // exists ("[TAURI] Couldn't find callback id ...").
        if (isTauri()) {
            window.addEventListener('beforeunload', () => {
                if (this.active()) void this.stopAll();
            });
        }
    }

    /** Whether the Rust engine is available at all. */
    available(): boolean {
        return isTauri();
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
    ): Promise<VoiceSession> {
        const channel = new Channel<VoiceEvent>();
        channel.onmessage = event => {
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
        };

        const session = await invoke<VoiceSession>('voice_start', {
            settings: this.settingsPayload(),
            // None, deliberately. Cloudflare's SFU is publicly routable, so host candidates reach
            // it and it answers to whatever source address it sees - which is why the DM call path
            // has never passed any (`call-webrtc.service.ts`, `new RTCPeerConnection` with only
            // bundlePolicy). Passing STUN servers here, copied from the screen publisher, bought
            // nothing and added the one step in ICE gathering that can block on the network.
            iceServers: [],
            apiBase,
            token,
            deviceId,
            guildId: target.kind === 'guild' ? target.guildId : null,
            channelId: target.kind === 'guild' ? target.channelId : null,
            callId: target.kind === 'call' ? target.callId : null,
            // Isle addresses no channel or call, so it is flagged rather than identified.
            isle: target.kind === 'isle',
            onEvent: channel,
        });

        // Rejoining the same slot replaces whatever was there, in Rust and here alike.
        this.subscribedBySlot.set(session.slot, new Set());
        this.runningSlots.update(slots => new Set(slots).add(session.slot));
        return session;
    }

    /** End one call. Every other call, and the microphone itself, keeps running. */
    async stop(session: VoiceSession): Promise<void> {
        this.forgetSlot(session.slot);
        if (!isTauri()) return;
        await invoke('voice_stop', {slot: session.slot});
    }

    /**
     * End every call at once.
     *
     * For a page reload, where the webview that started them is gone and there is nobody left to
     * name them individually. Ordinary hang-ups use {@link stop}.
     */
    async stopAll(): Promise<void> {
        this.subscribedBySlot.clear();
        this.runningSlots.set(new Set());
        this.speaking.set(false);
        this.level.set(0);
        this.remoteLevelsSignal.set(new Map());
        if (!isTauri()) return;
        await invoke('voice_stop', {slot: null});
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
        cfSessionId: string,
        trackName: string,
    ): Promise<void> {
        this.subscribedBySlot.get(session.slot)?.add(id);
        if (!isTauri()) return;
        await invoke('voice_subscribe', {slot: session.slot, id, cfSessionId, trackName});
    }

    async unsubscribe(session: VoiceSession, id: string): Promise<void> {
        this.subscribedBySlot.get(session.slot)?.delete(id);
        this.dropLevel(id);
        if (!isTauri()) return;
        await invoke('voice_unsubscribe', {slot: session.slot, id});
    }

    /**
     * Open or close the microphone *for one call*.
     *
     * Per call, not engine-wide: proximity push-to-talk must not also key the guild channel. The
     * microphone is captured once and stays live while any call wants it; this decides who hears it.
     */
    async setPttOpen(session: VoiceSession, open: boolean): Promise<void> {
        if (!isTauri()) return;
        await invoke('voice_set_ptt_open', {slot: session.slot, open});
    }

    /**
     * Mute the microphone itself, for every call at once.
     *
     * Engine-wide unlike push-to-talk, because muting is a statement about the microphone rather
     * than about a conversation - a mute that left you audible somewhere else would be the worst
     * possible way to discover that calls are separate.
     */
    async setMute(muted: boolean): Promise<void> {
        if (!isTauri()) return;
        await invoke('voice_set_mute', {muted});
    }

    /** Per-source volume, 0.0-1.0. */
    async setUserVolume(id: string, volume: number): Promise<void> {
        if (!isTauri()) return;
        await invoke('voice_set_user_volume', {id, volume});
    }

    async setDeafened(deafened: boolean): Promise<void> {
        if (!isTauri()) return;
        await invoke('voice_set_deafened', {deafened});
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
        if (!isTauri()) return;
        await invoke('voice_set_spatial_model', {
            refDistance: model.refDistance,
            rolloff: model.rolloff,
            maxDistance: model.maxDistance,
            intensity: model.intensity,
        });
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
        if (!isTauri()) return;
        await invoke('voice_set_position', {
            id,
            x: position?.x ?? null,
            y: position?.y ?? null,
            z: position?.z ?? null,
        });
    }

    /** Push the current settings to the engine. Safe to call when nothing is running. */
    async applySettings(): Promise<void> {
        if (!isTauri()) return;
        await invoke('voice_set_processing', {settings: this.settingsPayload()});
    }

    /** Drop a slot's local bookkeeping, including the meters of everyone who was on it. */
    private forgetSlot(slot: string): void {
        for (const id of this.subscribedBySlot.get(slot) ?? []) this.dropLevel(id);
        this.subscribedBySlot.delete(slot);
        this.runningSlots.update(slots => {
            const next = new Set(slots);
            next.delete(slot);
            return next;
        });
        if (!this.active()) {
            this.speaking.set(false);
            this.level.set(0);
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
    private settingsPayload() {
        return this.payloadFrom(this.audioSettings.settings());
    }

    private payloadFrom(s: AudioSettings) {
        return {
            deviceId: s.micId === 'default' ? null : s.micId,
            // Chosen when the engine opens the device, so like the microphone it takes effect once
            // the last call ends rather than immediately.
            outputDeviceId: s.speakerId === 'default' ? null : s.speakerId,
            noiseSuppression: s.noiseSuppressionMode,
            echoCancellation: s.echoCancellation,
            autoGainControl: s.autoGainControl,
            inputMode: s.inputMode === 'push-to-talk' ? 'ptt' : 'voice',
            // `inputSensitivity` is the slider that decides when the gate opens, stored 0-100. Not
            // `vadStrength`, which is a separate 0-1 control that only applied when enhanced noise
            // suppression was on - sending that one instead would leave the gate at its least
            // sensitive setting by default and cut off anyone speaking quietly.
            sensitivity: Math.min(1, Math.max(0, s.inputSensitivity / 100)),
            // Both sliders are stored 0-100 and consumed as gains. Until now nothing read either of
            // them: the microphone and output volume controls moved, saved, and changed nothing.
            inputVolume: asGain(s.inputVolume),
            outputVolume: asGain(s.outputVolume),
            bitrateBps: null,
        };
    }
}
