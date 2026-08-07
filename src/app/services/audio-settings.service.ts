import {inject, Injectable, signal} from '@angular/core';
import {MediaDeviceResolverService} from './media-device-resolver.service';

export interface AudioSettings {
    /**
     * Selected microphone. Holds the platform device *name* (as returned by the
     * Tauri `enumerate_audio_devices` command) because the Rust capture pipeline
     * looks devices up by cpal name. Web APIs need an id from
     * `enumerateDevices()` instead -go through {@link MediaDeviceResolverService}.
     */
    micId: string;
    /** Selected speaker; same name-vs-web-id caveat as {@link micId}. */
    speakerId: string;
    /** Selected camera ('' = none); same name-vs-web-id caveat as {@link micId}. */
    cameraId: string;
    /**
     * Mirrors Discord's None / Standard / Krisp. 'standard' is the browser's own filter;
     * 'enhanced' routes capture through the Rust RNNoise pipeline.
     */
    noiseSuppressionMode: 'none' | 'standard' | 'enhanced';
    echoCancellation: boolean;
    autoGainControl: boolean;
    /** Microphone input gain, 0-100. */
    inputVolume: number;
    /** Output volume applied to remote audio, 0-100. */
    outputVolume: number;
    /** VAD gating strength when enhanced NS is active (0 = off, 1 = aggressive) */
    vadStrength: number;
    /** Master output volume for Isle proximity voice (0–1). */
    proximityVolume: number;
    /**
     * Outgoing microphone gain for Isle proximity voice. 1 = 100% (unity); values
     * above 1 boost past the source level (Discord-style, up to 2 = 200%).
     */
    proximityMicGain: number;
    /** Whether Isle proximity voice uses HRTF directional panning (false = distance-only). */
    proximitySpatialEnabled: boolean;
    /** How the mic decides when to transmit for regular (non-Isle) calls. */
    inputMode: 'voice-activity' | 'push-to-talk';
    /**
     * Where the voice-activity gate cuts off, 0 (transmits almost anything) – 100 (only clearly
     * loud speech). Ignored in push-to-talk mode.
     *
     * A cutoff, not a sensitivity: it is the knob position on the meter in the settings page, and
     * on that meter left is permissive and right is strict. The engine still speaks in
     * sensitivity - see `payloadFrom` in `voice-engine.service.ts`, which is the one place the two
     * vocabularies meet.
     *
     * This replaced `inputSensitivity`, which ran the other way. Stored values are not migrated:
     * the gate underneath changed from an absolute threshold to one relative to the room, so an
     * old number would not have meant the same thing on the new scale even reversed.
     */
    voiceThreshold: number;
}

export const DEFAULTS: AudioSettings = {
    micId: 'default',
    speakerId: 'default',
    cameraId: '',
    noiseSuppressionMode: 'standard',
    echoCancellation: true,
    autoGainControl: true,
    inputVolume: 100,
    outputVolume: 100,
    vadStrength: 0,
    proximityVolume: 1,
    proximityMicGain: 1,
    proximitySpatialEnabled: true,
    inputMode: 'voice-activity',
    // 40 leaves the gate opening about 9 dB above whatever the room measures - permissive enough
    // that ordinary speech never has to fight it, strict enough to sit above room tone.
    voiceThreshold: 40,
};

const STORAGE_KEY = 'alpine_audio_settings';

@Injectable({providedIn: 'root'})
export class AudioSettingsService {
    readonly settings = signal<AudioSettings>(this.load());

    private readonly devices = inject(MediaDeviceResolverService);

    update(patch: Partial<AudioSettings>): void {
        this.settings.update(s => {
            const next = {...s, ...patch};
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            return next;
        });
    }

    /**
     * Build getUserMedia audio constraints (used when enhanced NS is off).
     *
     * Async because {@link micId} is a platform device name, which has to be
     * resolved against `enumerateDevices()` before getUserMedia will honour it.
     */
    async buildAudioConstraint(): Promise<MediaTrackConstraints> {
        const s = this.settings();
        const deviceId = await this.devices.toWebDeviceId('audioinput', s.micId);
        return {
            // `ideal`, not `exact`: if the mic vanished between resolution and
            // capture we'd rather get the default than fail the whole call.
            deviceId: deviceId ? {ideal: deviceId} : undefined,
            // 'enhanced' is handled by the Rust pipeline, so the browser filter stays off for it.
            noiseSuppression: s.noiseSuppressionMode === 'standard',
            echoCancellation: s.echoCancellation,
            autoGainControl: s.autoGainControl,
        };
    }

    /** Build getUserMedia video constraint from current settings. */
    async buildVideoConstraint(): Promise<MediaTrackConstraints> {
        const deviceId = await this.devices.toWebDeviceId('videoinput', this.settings().cameraId);
        return deviceId ? {deviceId: {ideal: deviceId}} : {};
    }

    /**
     * Web sink id for the selected speaker, for `setSinkId` on an `<audio>`
     * element or an `AudioContext`. `''` means the system default sink.
     */
    resolveSpeakerSinkId(): Promise<string> {
        return this.devices.toWebDeviceId('audiooutput', this.settings().speakerId);
    }

    private load(): AudioSettings {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return {...DEFAULTS};
            return migrate(JSON.parse(raw) as Record<string, unknown>);
        } catch {
            return {...DEFAULTS};
        }
    }
}

/**
 * Per-stream bitrates, removed when stream quality moved to resolution + framerate presets chosen
 * at share time. Bitrate is now derived from the preset (see `models/stream-preset.ts`).
 */
const DROPPED_KEYS = [
    'audioBitrate',
    'screenAudioBitrate',
    'videoBitrate',
    'screenVideoBitrate',
    'noiseSuppression',
    'enhancedNoiseSuppression',
];

/**
 * Fold a persisted settings blob onto the current shape.
 *
 * Runs on every construction, so it must be idempotent: a blob that has already been migrated
 * carries `noiseSuppressionMode` and no legacy toggles, and must survive unchanged.
 */
function migrate(stored: Record<string, unknown>): AudioSettings {
    const next: Record<string, unknown> = {...DEFAULTS, ...stored};

    // Test the stored blob, not `next` - DEFAULTS always supplies a mode, so `next` is never
    // missing one and the legacy toggles would be ignored.
    if (stored['noiseSuppressionMode'] === undefined) {
        next['noiseSuppressionMode'] = stored['enhancedNoiseSuppression'] === true
            ? 'enhanced'
            : stored['noiseSuppression'] === false ? 'none' : 'standard';
    }

    for (const key of DROPPED_KEYS) delete next[key];
    return next as unknown as AudioSettings;
}
