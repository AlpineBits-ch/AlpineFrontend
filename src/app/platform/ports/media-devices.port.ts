/**
 * One selectable capture or playback device.
 *
 * <p><b>`id` is host-scoped and is not interchangeable between adapters.</b> The Tauri adapter
 * reports cpal device *names*, because that is what the Rust capture pipeline looks devices up by;
 * the web adapter reports `MediaDeviceInfo.deviceId`. That is the contract already documented on
 * `AudioSettings.micId`, and it is why `MediaDeviceResolverService` exists. A persisted id from one
 * host means nothing on the other, which is fine - a stored device that cannot be found falls back
 * to the default, exactly as an unplugged one does.</p>
 */
export interface MediaDeviceEntry {
    id: string;
    label: string;
    isDefault: boolean;
}

/**
 * The microphones, speakers and cameras this machine has.
 *
 * <p>One enumerator for every surface that offers a choice. Two copies of this is how the voice
 * settings page and the bottom bar's device chevrons started disagreeing about what was plugged
 * in.</p>
 */
export abstract class MediaDeviceSource {
    abstract inputs(): Promise<MediaDeviceEntry[]>;

    abstract outputs(): Promise<MediaDeviceEntry[]>;

    abstract cameras(): Promise<MediaDeviceEntry[]>;

    /**
     * Fires when the set of devices changes - a headset plugged in, a monitor with speakers waking.
     *
     * <p>Synchronous, and returns its own teardown: subscribing is a local event listener on both
     * hosts, so unlike the other ports here there is nothing to await.</p>
     */
    abstract onChange(handler: () => void): () => void;
}
