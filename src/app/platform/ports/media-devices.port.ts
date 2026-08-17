/**
 * One selectable capture or playback device.
 *
 * `id` is host-scoped and not interchangeable between adapters: cpal device names on Tauri,
 * `MediaDeviceInfo.deviceId` on web.
 */
export interface MediaDeviceEntry {
    id: string;
    label: string;
    isDefault: boolean;
}

/** The microphones, speakers and cameras this machine has. One enumerator for every surface. */
export abstract class MediaDeviceSource {
    abstract inputs(): Promise<MediaDeviceEntry[]>;

    abstract outputs(): Promise<MediaDeviceEntry[]>;

    abstract cameras(): Promise<MediaDeviceEntry[]>;

    /** Fires when the set of devices changes. Synchronous, and returns its own teardown. */
    abstract onChange(handler: () => void): () => void;
}
