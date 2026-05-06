import { Injectable, signal } from '@angular/core';

export type SoundKey = 'incomingCall' | 'outgoingCall' | 'message' | 'voiceJoin' | 'voiceLeave';

export interface SoundConfig {
  volume: number;       // 0–1
  customUrl?: string;   // data: URL from uploaded file; undefined = built-in synth
  customName?: string;  // original filename shown in UI
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
  incomingCall: { volume: 1 },
  outgoingCall: { volume: 1 },
  message: { volume: 1 },
  voiceJoin: { volume: 1 },
  voiceLeave: { volume: 1 },
};

@Injectable({ providedIn: 'root' })
export class SoundSettingsService {
  readonly settings = signal<SoundSettings>(this.load());

  update(key: SoundKey, patch: Partial<SoundConfig>): void {
    this.settings.update(s => {
      const next = { ...s, [key]: { ...s[key], ...patch } };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* quota exceeded */ }
      return next;
    });
  }

  playIncomingRing(): void {
    const s = this.settings().incomingCall;
    if (s.volume === 0) return;
    if (s.customUrl) { this.playFile(s.customUrl, s.volume); return; }
    try {
      const vol = 0.20 * s.volume;
      const ctx = new AudioContext();
      const pulse = (freq: number, t: number, v = vol) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(v, t + 0.01);
        gain.gain.setValueAtTime(v, t + 0.09);
        gain.gain.linearRampToValueAtTime(0, t + 0.13);
        osc.start(t);
        osc.stop(t + 0.15);
      };
      pulse(659, ctx.currentTime);
      pulse(880, ctx.currentTime + 0.14);
      pulse(1047, ctx.currentTime + 0.28, 0.18 * s.volume);
      pulse(659, ctx.currentTime + 0.55);
      pulse(880, ctx.currentTime + 0.69);
      pulse(1047, ctx.currentTime + 0.83, 0.18 * s.volume);
      setTimeout(() => ctx.close(), 1200);
    } catch { /* AudioContext unavailable */ }
  }

  playRingback(): void {
    const s = this.settings().outgoingCall;
    if (s.volume === 0) return;
    if (s.customUrl) { this.playFile(s.customUrl, s.volume); return; }
    try {
      const vol = 0.12 * s.volume;
      const ctx = new AudioContext();
      const tone = (freq: number, t: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(vol, t + 0.015);
        gain.gain.setValueAtTime(vol, t + 0.38);
        gain.gain.linearRampToValueAtTime(0, t + 0.42);
        osc.start(t);
        osc.stop(t + 0.45);
      };
      tone(440, ctx.currentTime);
      tone(480, ctx.currentTime);
      tone(440, ctx.currentTime + 0.65);
      tone(480, ctx.currentTime + 0.65);
      setTimeout(() => ctx.close(), 1800);
    } catch { /* AudioContext unavailable */ }
  }

  playMessage(): void {
    const s = this.settings().message;
    if (s.volume === 0) return;
    if (s.customUrl) { this.playFile(s.customUrl, s.volume); return; }
    try {
      const maxGain = 0.07 * s.volume;
      const ctx = new AudioContext();
      const t = ctx.currentTime;
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(maxGain, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      for (const [freq, start, stop] of [
        [880, t, t + 0.18],
        [1108, t + 0.09, t + 0.45],
      ] as const) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(start);
        osc.stop(stop);
      }
    } catch { /* AudioContext unavailable */ }
  }

  playVoiceJoin(): void {
    const s = this.settings().voiceJoin;
    if (s.volume === 0) return;
    if (s.customUrl) { this.playFile(s.customUrl, s.volume); return; }
    try {
      const vol = 0.15 * s.volume;
      const ctx = new AudioContext();
      const note = (freq: number, t: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(vol, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
        osc.start(t);
        osc.stop(t + 0.3);
      };
      note(880, ctx.currentTime);
      note(1108, ctx.currentTime + 0.13);
      setTimeout(() => ctx.close(), 600);
    } catch { /* AudioContext unavailable */ }
  }

  playVoiceLeave(): void {
    const s = this.settings().voiceLeave;
    if (s.volume === 0) return;
    if (s.customUrl) { this.playFile(s.customUrl, s.volume); return; }
    try {
      const vol = 0.15 * s.volume;
      const ctx = new AudioContext();
      const note = (freq: number, t: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(vol, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
        osc.start(t);
        osc.stop(t + 0.3);
      };
      note(1108, ctx.currentTime);
      note(880, ctx.currentTime + 0.13);
      setTimeout(() => ctx.close(), 600);
    } catch { /* AudioContext unavailable */ }
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
        incomingCall: { ...DEFAULTS.incomingCall, ...parsed.incomingCall },
        outgoingCall: { ...DEFAULTS.outgoingCall, ...parsed.outgoingCall },
        message: { ...DEFAULTS.message, ...parsed.message },
        voiceJoin: { ...DEFAULTS.voiceJoin, ...parsed.voiceJoin },
        voiceLeave: { ...DEFAULTS.voiceLeave, ...parsed.voiceLeave },
      };
    } catch {
      return structuredClone(DEFAULTS);
    }
  }
}
