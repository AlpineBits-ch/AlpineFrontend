import {effect, inject, Injectable, signal} from '@angular/core';
import {Channel, invoke, isTauri} from '@tauri-apps/api/core';
import {AudioSettings, AudioSettingsService} from './audio-settings.service';

/** Which call surface the session belongs to. Mirrors the Rust `VoiceTarget`. */
export type VoiceTarget =
    | {kind: 'guild'; guildId: string; channelId: string}
    | {kind: 'call'; callId: string};

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

export interface VoiceStartResult {
    cfSessionId: string;
    trackName: string;
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
 * The Angular face of the Rust voice session.
 *
 * Every call service talks to this rather than calling `invoke` directly, so the fact that there is
 * exactly one microphone and one session is enforced in one place.
 */
@Injectable({providedIn: 'root'})
export class VoiceEngineService {
    private readonly audioSettings = inject(AudioSettingsService);

    /**
     * Whether the local user is currently transmitting.
     *
     * The only speaking signal in the app. It replaces the two independent VAD `AudioContext`s,
     * which disagreed with each other and with the gate that actually decided what was sent.
     */
    readonly speaking = signal(false);
    /** Input level, 0.0-1.0, for the microphone meter. */
    readonly level = signal(0);
    readonly active = signal(false);

    /**
     * Every remote participant's meter, keyed by source id.
     *
     * The only remote speaking signal once playout moves to Rust: there are no `<audio>` elements
     * left for the webview to analyse, and this comes from the same decoded frames that reach the
     * speakers, so it cannot disagree with what is audible.
     */
    private readonly remoteLevelsSignal = signal<ReadonlyMap<string, RemoteLevel>>(new Map());
    readonly remoteLevels = this.remoteLevelsSignal.asReadonly();

    constructor() {
        // Push settings changes into a running session. Without this the audio settings page would
        // appear to work and change nothing until the next rejoin - and the input-mode switch in
        // particular would be silently dead, because the gate that reads it now lives in Rust.
        //
        // The input *device* is the exception: it is chosen when the capture stream is opened, so
        // switching microphones still takes effect on the next join.
        effect(() => {
            const payload = this.payloadFrom(this.audioSettings.settings());
            if (!this.active() || !isTauri()) return;
            void invoke('voice_set_processing', {settings: payload});
        });

        // A page reload does not unwind Rust. Without this the session keeps capturing and
        // publishing into the channel after the webview that started it is gone - audible to
        // everyone else, invisible here, and emitting events at a callback id that no longer
        // exists ("[TAURI] Couldn't find callback id ..."). `voice_start` does stop a leftover
        // session, but only once you get as far as joining again.
        if (isTauri()) {
            window.addEventListener('beforeunload', () => {
                if (this.active()) void invoke('voice_stop');
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
    ): Promise<VoiceStartResult> {
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

        const result = await invoke<VoiceStartResult>('voice_start', {
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
            onEvent: channel,
        });

        this.active.set(true);
        return result;
    }

    async stop(): Promise<void> {
        this.active.set(false);
        this.speaking.set(false);
        this.level.set(0);
        this.remoteLevelsSignal.set(new Map());
        if (!isTauri()) return;
        await invoke('voice_stop');
    }

    /**
     * Pull a participant's audio into the mix.
     *
     * `id` is the key for volume, levels and unsubscribe. Voice uses the user id; a stream's audio
     * uses its track name, so that muting someone's stream does not also mute their voice.
     *
     * Rejects rather than resolving quietly on failure - nothing retries a subscribe, so a swallowed
     * error here is a participant who stays silent for the rest of the session.
     */
    async subscribe(id: string, cfSessionId: string, trackName: string): Promise<void> {
        if (!isTauri()) return;
        await invoke('voice_subscribe', {id, cfSessionId, trackName});
    }

    async unsubscribe(id: string): Promise<void> {
        this.remoteLevelsSignal.update(m => {
            const n = new Map(m);
            n.delete(id);
            return n;
        });
        if (!isTauri()) return;
        await invoke('voice_unsubscribe', {id});
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

    async setMute(muted: boolean): Promise<void> {
        if (!isTauri()) return;
        await invoke('voice_set_mute', {muted});
    }

    async setPttOpen(open: boolean): Promise<void> {
        if (!isTauri()) return;
        await invoke('voice_set_ptt_open', {open});
    }

    /** Push the current settings to a running session. Safe to call when nothing is running. */
    async applySettings(): Promise<void> {
        if (!isTauri()) return;
        await invoke('voice_set_processing', {settings: this.settingsPayload()});
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
            // Chosen when the output stream opens, so like the microphone it takes effect on the
            // next join rather than immediately.
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
