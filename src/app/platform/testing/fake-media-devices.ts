import {MediaDeviceEntry, MediaDeviceSource} from '../ports/media-devices.port';

/** One entry, with the fields a spec rarely cares about filled in. */
export function deviceEntry(id: string, label = id, isDefault = false): MediaDeviceEntry {
    return {id, label, isDefault};
}

/**
 * A {@link MediaDeviceSource} for specs, provided in TestBed in place of an adapter.
 *
 * <p>Replaces the `vi.mock('@tauri-apps/api/core')` in the device specs and, more usefully, the
 * `navigator.mediaDevices` stubs: touching neither means a spec cannot accidentally depend on what the
 * machine running it has plugged in, which is the failure that makes a device test pass locally and fail
 * in CI.</p>
 *
 * <p><b>Defaults to no devices at all</b>, and that is the honest inert state - a fake has no hardware.
 * It is also the state most worth having as a baseline, because "nothing is plugged in" is the branch a
 * settings page is least likely to have been written for. A spec that is about devices seeds the three
 * lists directly; {@link withDefaults} is the one-liner for "an ordinary machine".</p>
 *
 * <p>{@link change} fires the enumerator's own event, which is what a stubbed `navigator` could not do
 * without a real `MediaDeviceInfo` list - and the reason it matters is that the voice settings page and
 * the bottom bar's device chevrons read the same source precisely so they cannot disagree about what is
 * plugged in.</p>
 */
export class FakeMediaDeviceSource extends MediaDeviceSource {
    /** Microphones. */
    inputDevices: MediaDeviceEntry[] = [];

    /** Speakers. Empty is also the truthful answer for a browser without `setSinkId`. */
    outputDevices: MediaDeviceEntry[] = [];

    cameraDevices: MediaDeviceEntry[] = [];

    /** How many times each list was enumerated, so a caller's caching is assertable. */
    readonly enumerations = {inputs: 0, outputs: 0, cameras: 0};

    /** Set to make every enumeration reject - a permission the host refused outright. */
    error: Error | null = null;

    private readonly handlers = new Set<() => void>();

    /** One default device of each kind, which is what an ordinary machine looks like. */
    withDefaults(): this {
        this.inputDevices = [deviceEntry('mic-default', 'Default microphone', true)];
        this.outputDevices = [deviceEntry('out-default', 'Default speakers', true)];
        this.cameraDevices = [deviceEntry('cam-default', 'Default camera', true)];
        return this;
    }

    async inputs(): Promise<MediaDeviceEntry[]> {
        this.enumerations.inputs++;
        if (this.error) throw this.error;
        return [...this.inputDevices];
    }

    async outputs(): Promise<MediaDeviceEntry[]> {
        this.enumerations.outputs++;
        if (this.error) throw this.error;
        return [...this.outputDevices];
    }

    async cameras(): Promise<MediaDeviceEntry[]> {
        this.enumerations.cameras++;
        if (this.error) throw this.error;
        return [...this.cameraDevices];
    }

    /** Synchronous, like the port: subscribing is a local listener on both hosts. */
    onChange(handler: () => void): () => void {
        this.handlers.add(handler);
        return () => void this.handlers.delete(handler);
    }

    /** Fires `devicechange` - a headset plugged in, a monitor with speakers waking. */
    change(): void {
        for (const handler of [...this.handlers]) handler();
    }

    /** Whether anything is still listening. A teardown that ran leaves this at zero. */
    get handlerCount(): number {
        return this.handlers.size;
    }
}
