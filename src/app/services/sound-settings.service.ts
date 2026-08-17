import {Injectable, signal} from '@angular/core';

export type SoundKey = 'incomingCall' | 'outgoingCall' | 'message' | 'voiceJoin' | 'voiceLeave';

export interface SoundConfig {
    volume: number; // 0–1
    customUrl?: string; // data: URL from uploaded file; undefined = bundled default sound
    customName?: string; // original filename shown in UI
}

export interface SoundSettings {
    incomingCall: SoundConfig;
    outgoingCall: SoundConfig;
    message: SoundConfig;
    voiceJoin: SoundConfig;
    voiceLeave: SoundConfig;
}

const STORAGE_KEY = 'alpine_sound_settings';

const DEFAULTS: SoundSettings = {
    incomingCall: {volume: 1},
    outgoingCall: {volume: 1},
    message: {volume: 1},
    voiceJoin: {volume: 1},
    voiceLeave: {volume: 1},
};

@Injectable({providedIn: 'root'})
export class SoundSettingsService {
    readonly settings = signal<SoundSettings>(this.load());

    update(key: SoundKey, patch: Partial<SoundConfig>): void {
        this.settings.update(s => {
            const next = {...s, [key]: {...s[key], ...patch}};
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            } catch {
                /* quota exceeded */
            }
            return next;
        });
    }

    playIncomingRing(): void {
        const s = this.settings().incomingCall;
        if (s.volume === 0) return;
        this.playFile(s.customUrl ?? '/assets/sounds/ring_incoming.wav', s.volume);
    }

    playRingback(): void {
        const s = this.settings().outgoingCall;
        if (s.volume === 0) return;
        this.playFile(s.customUrl ?? '/assets/sounds/ring_outgoing.wav', s.volume);
    }

    playMessage(): void {
        const s = this.settings().message;
        if (s.volume === 0) return;
        this.playFile(s.customUrl ?? '/assets/sounds/new_message.wav', s.volume);
    }

    playVoiceJoin(): void {
        const s = this.settings().voiceJoin;
        if (s.volume === 0) return;
        this.playFile(s.customUrl ?? '/assets/sounds/join_call.wav', s.volume);
    }

    playVoiceLeave(): void {
        const s = this.settings().voiceLeave;
        if (s.volume === 0) return;
        this.playFile(s.customUrl ?? '/assets/sounds/leave_call.wav', s.volume);
    }

    private playFile(url: string, volume: number): void {
        const audio = new Audio(url);
        audio.volume = Math.max(0, Math.min(1, volume));
        void audio.play().catch(() => {});
    }

    private load(): SoundSettings {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return structuredClone(DEFAULTS);
            const parsed = JSON.parse(raw) as Partial<SoundSettings>;
            return {
                incomingCall: {...DEFAULTS.incomingCall, ...parsed.incomingCall},
                outgoingCall: {...DEFAULTS.outgoingCall, ...parsed.outgoingCall},
                message: {...DEFAULTS.message, ...parsed.message},
                voiceJoin: {...DEFAULTS.voiceJoin, ...parsed.voiceJoin},
                voiceLeave: {...DEFAULTS.voiceLeave, ...parsed.voiceLeave},
            };
        } catch {
            return structuredClone(DEFAULTS);
        }
    }
}
