import {inject, Injectable, signal} from '@angular/core';
import {MediaDeviceEntry, MediaDeviceSource} from '../platform/ports/media-devices.port';
import {hasWithheldNames, OutputSupport, outputSupportOf} from '../platform/media-device-support';

export interface DeviceOption {
    label: string;
    value: string;
}

/**
 * What {@link MediaDeviceCatalogService.outputSupport} says before the first refresh settles: what
 * the only host that existed before the port did, so nothing that reads it flickers into a gated
 * state on desktop.
 *
 * <p>Declared here rather than imported as `fullOutputSupport()` deliberately - see that function's
 * note. A cross-module binding read from a class field initialiser is the one position where it
 * resolves to `undefined` under the unit-test builder.</p>
 */
const ASSUMED_OUTPUT_SUPPORT: OutputSupport = {enumerable: true, selectable: true};

/**
 * The microphones and speakers this machine has, for every surface that offers a choice.
 *
 * <p>Enumeration used to live inside the voice settings page, which was fine while that page was
 * the only chooser. The bottom bar's device chevrons are a second one, and two copies of the same
 * enumeration is how two lists start disagreeing about what is plugged in.</p>
 *
 * <p>A thin delegate over {@link MediaDeviceSource} since the port migration: the host-specific part
 * - three Tauri commands on desktop, `navigator.mediaDevices.enumerateDevices()` in a browser - lives
 * in `src/app/platform/`, and this service keeps the signal/option shape its consumers bind to.</p>
 *
 * <p><b>The ids here are host-scoped.</b> On desktop they are platform device *names*, which is the
 * contract documented on {@link AudioSettings.micId}: the Rust capture pipeline looks devices up by
 * cpal name, and anything handing one of these to `getUserMedia` or `setSinkId` has to translate it
 * first through `MediaDeviceResolverService`. In a browser they are already
 * `MediaDeviceInfo.deviceId`s, and the resolver passes them through.</p>
 */
@Injectable({providedIn: 'root'})
export class MediaDeviceCatalogService {
    readonly mics = signal<DeviceOption[]>([]);
    readonly speakers = signal<DeviceOption[]>([]);

    /**
     * Whether any listed device is showing a stand-in name rather than its own.
     *
     * <p>True in a browser until the page holds a media permission: `enumerateDevices()` hands back
     * real ids and blank labels, and the web adapter substitutes "Microphone 2" rather than rendering
     * a nameless row. Surfaces that can explain it should - "grant microphone access to see device
     * names" - because a numbered list is usable but not informative. Always false on desktop.</p>
     */
    readonly namesWithheld = signal(false);

    /**
     * Whether a speaker picker means anything on this host.
     *
     * <p><b>This is what separates "no output devices" from "this browser will not tell us".</b>
     * `speakers()` is empty in both cases; only this says which, and only `selectable` says whether
     * audio could be routed to a choice at all. Gate the output picker on it - the design spec's rule
     * is that no control is left enabled over a no-op.</p>
     *
     * <p>Starts at {@link ASSUMED_OUTPUT_SUPPORT}, the desktop answer, and is replaced when the first
     * refresh settles.</p>
     */
    readonly outputSupport = signal<OutputSupport>(ASSUMED_OUTPUT_SUPPORT);

    private readonly devices = inject(MediaDeviceSource);

    /** The refresh currently in flight, so concurrent callers share one round trip. */
    private inFlight: Promise<void> | null = null;

    constructor() {
        void this.refresh();

        // Fires when a headset is plugged in, or when a monitor with speakers wakes up. Cheap to
        // honour, and the alternative is a stale list in a menu the user opened precisely because
        // they just plugged something in.
        this.devices.onChange(() => void this.refresh());
    }

    /** Re-read both lists. Safe to call on every menu open. */
    refresh(): Promise<void> {
        this.inFlight ??= this.load().finally(() => {
            this.inFlight = null;
        });
        return this.inFlight;
    }

    private async load(): Promise<void> {
        // Each list is caught on its own. Conflating them - one `try` around both - is how a host
        // that cannot enumerate outputs was made to look like a machine with no microphone either.
        const [mics, speakers, outputSupport] = await Promise.all([
            this.enumerate(() => this.devices.inputs()),
            this.enumerate(() => this.devices.outputs()),
            outputSupportOf(this.devices),
        ]);

        this.mics.set(mics.map(toOption));
        this.speakers.set(speakers.map(toOption));
        this.namesWithheld.set(hasWithheldNames(mics) || hasWithheldNames(speakers));
        this.outputSupport.set(outputSupport);
    }

    /**
     * One list, or an empty one.
     *
     * <p>Empty has to be a state this service reaches deliberately rather than one it falls into: a
     * machine really can have no microphone, so every consumer already handles it. What must not
     * happen is the whole refresh rejecting and leaving the previous lists in place.</p>
     */
    private async enumerate(read: () => Promise<MediaDeviceEntry[]>): Promise<MediaDeviceEntry[]> {
        try {
            return await read();
        } catch (error) {
            console.warn('[media-devices] enumeration failed', error);
            return [];
        }
    }
}

function toOption(device: MediaDeviceEntry): DeviceOption {
    return {label: device.label, value: device.id};
}
