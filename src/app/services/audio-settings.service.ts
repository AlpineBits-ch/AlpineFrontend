import { Injectable, signal } from '@angular/core';

export interface AudioSettings {
  micId: string;
  speakerId: string;
  cameraId: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  audioBitrate: number;
  screenAudioBitrate: number;
  videoBitrate: number;
  screenVideoBitrate: number;
  /** Use Rust-based capture pipeline with RNNoise noise suppression */
  enhancedNoiseSuppression: boolean;
  /** VAD gating strength when enhanced NS is active (0 = off, 1 = aggressive) */
  vadStrength: number;
}

const DEFAULTS: AudioSettings = {
  micId: 'default',
  speakerId: 'default',
  cameraId: '',
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  audioBitrate: 64,
  screenAudioBitrate: 256,
  videoBitrate: 1500,
  screenVideoBitrate: 4000,
  enhancedNoiseSuppression: false,
  vadStrength: 0,
};

const STORAGE_KEY = 'alpine_audio_settings';

@Injectable({ providedIn: 'root' })
export class AudioSettingsService {
  readonly settings = signal<AudioSettings>(this.load());

  update(patch: Partial<AudioSettings>): void {
    this.settings.update(s => {
      const next = { ...s, ...patch };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  /** Build getUserMedia audio constraints (used when enhanced NS is off). */
  buildAudioConstraint(): MediaTrackConstraints {
    const s = this.settings();
    return {
      deviceId: s.micId !== 'default' ? { ideal: s.micId } : undefined,
      noiseSuppression: s.noiseSuppression,
      echoCancellation: s.echoCancellation,
      autoGainControl:  s.autoGainControl,
    };
  }

  /** Build getUserMedia video constraint from current settings. */
  buildVideoConstraint(): MediaTrackConstraints {
    const s = this.settings();
    return s.cameraId ? { deviceId: { ideal: s.cameraId } } : {};
  }

  private load(): AudioSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw) as Partial<AudioSettings>;
      return { ...DEFAULTS, ...parsed };
    } catch {
      return { ...DEFAULTS };
    }
  }
}
