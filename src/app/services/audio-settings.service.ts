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
    /** Master output volume for Isle proximity voice (0–1). */
    proximityVolume: number;
    /**
     * Outgoing microphone gain for Isle proximity voice. 1 = 100% (unity); values
     * above 1 boost past the source level (Discord-style, up to 2 = 200%).
     */
    proximityMicGain: number;
    /** Whether Isle proximity voice uses HRTF directional panning (false = distance-only). */
    proximitySpatialEnabled: boolean;
    /** Global push-to-talk accelerator for Isle proximity voice (Tauri global-shortcut syntax). */
    proximityPttKey: string;
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
    proximityVolume: 1,
    proximityMicGain: 1,
    proximitySpatialEnabled: true,
    proximityPttKey: 'Backquote',
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
            noiseSuppression: s.noiseSuppression,
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
            const parsed = JSON.parse(raw) as Partial<AudioSettings>;
            return {...DEFAULTS, ...parsed};
        } catch {
            return {...DEFAULTS};
        }
    }
}
