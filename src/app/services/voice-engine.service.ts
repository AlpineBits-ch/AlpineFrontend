import {effect, inject, Injectable, signal} from '@angular/core';
import {Channel, invoke, isTauri} from '@tauri-apps/api/core';
import {AudioSettings, AudioSettingsService} from './audio-settings.service';

/** Which call surface the session belongs to. Mirrors the Rust `VoiceTarget`. */
export type VoiceTarget =
    | {kind: 'guild'; guildId: string; channelId: string}
    | {kind: 'call'; callId: string};

interface VoiceEvent {
    kind: 'speaking' | 'error';
    speaking: boolean;
    level: number;
    message?: string;
}

export interface VoiceStartResult {
    cfSessionId: string;
    trackName: string;
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
     * `apiBase` and `token` are passed in rather than read here, matching how the screen publisher
     * is called. Rust owns neither session lifetime nor token refresh.
     */
    async start(target: VoiceTarget, apiBase: string, token: string): Promise<VoiceStartResult> {
        const channel = new Channel<VoiceEvent>();
        channel.onmessage = event => {
            if (event.kind === 'error') {
                console.error('[voice] engine error:', event.message);
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
        if (!isTauri()) return;
        await invoke('voice_stop');
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
            noiseSuppression: s.noiseSuppressionMode,
            echoCancellation: s.echoCancellation,
            autoGainControl: s.autoGainControl,
            inputMode: s.inputMode === 'push-to-talk' ? 'ptt' : 'voice',
            // `inputSensitivity` is the slider that decides when the gate opens, stored 0-100. Not
            // `vadStrength`, which is a separate 0-1 control that only applied when enhanced noise
            // suppression was on - sending that one instead would leave the gate at its least
            // sensitive setting by default and cut off anyone speaking quietly.
            sensitivity: Math.min(1, Math.max(0, s.inputSensitivity / 100)),
            bitrateBps: null,
        };
    }
}
