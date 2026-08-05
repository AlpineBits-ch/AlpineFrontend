import {Injectable, signal} from '@angular/core';
import {invoke} from '@tauri-apps/api/core';

export interface DeviceOption {
    label: string;
    value: string;
}

interface RustAudioDevice {
    id: string;
    name: string;
    isDefault?: boolean;
}

/**
 * The microphones and speakers this machine has, for every surface that offers a choice.
 *
 * <p>Enumeration used to live inside the voice settings page, which was fine while that page was
 * the only chooser. The bottom bar's device chevrons are a second one, and two copies of the same
 * Tauri call is how two lists start disagreeing about what is plugged in.</p>
 *
 * <p><b>The ids here are platform device *names*, not web device ids.</b> That is the contract
 * documented on {@link AudioSettings.micId}: the Rust capture pipeline looks devices up by cpal
 * name, and anything handing one of these to `getUserMedia` or `setSinkId` has to translate it
 * first through `MediaDeviceResolverService`.</p>
 */
@Injectable({providedIn: 'root'})
export class MediaDeviceCatalogService {
    readonly mics = signal<DeviceOption[]>([]);
    readonly speakers = signal<DeviceOption[]>([]);

    /** The refresh currently in flight, so concurrent callers share one round trip. */
    private inFlight: Promise<void> | null = null;

    constructor() {
        void this.refresh();

        // Fires when a headset is plugged in, or when a monitor with speakers wakes up. Cheap to
        // honour, and the alternative is a stale list in a menu the user opened precisely because
        // they just plugged something in.
        navigator.mediaDevices?.addEventListener?.('devicechange', () => void this.refresh());
    }

    /** Re-read both lists. Safe to call on every menu open. */
    refresh(): Promise<void> {
        this.inFlight ??= this.load().finally(() => {
            this.inFlight = null;
        });
        return this.inFlight;
    }

    private async load(): Promise<void> {
        try {
            const [mics, speakers] = await Promise.all([
                invoke<RustAudioDevice[]>('enumerate_audio_devices'),
                invoke<RustAudioDevice[]>('enumerate_output_devices'),
            ]);
            this.mics.set(mics.map(d => ({label: d.name, value: d.id})));
            this.speakers.set(speakers.map(d => ({label: d.name, value: d.id})));
        } catch {
            // No Tauri side - the browser build - or the host refused. Empty is the honest answer,
            // and every consumer already has to handle it: a machine really can have no microphone.
            this.mics.set([]);
            this.speakers.set([]);
        }
    }
}
