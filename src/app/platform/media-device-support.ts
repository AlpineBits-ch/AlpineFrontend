import {MediaDeviceEntry, MediaDeviceSource} from './ports/media-devices.port';

/**
 * The two things a {@link MediaDeviceSource} has to be able to say that its array-returning methods
 * cannot: that a label was withheld, and that outputs are neither enumerable nor selectable.
 *
 * Both travel alongside the port, additively: an adapter that reports nothing reads as fully capable.
 */

/** Where an entry's `label` came from. */
export type MediaDeviceLabelSource =
    /** The host named the device. */
    | 'host'
    /** The host withheld the name and the adapter substituted a readable stand-in. */
    | 'placeholder';

/**
 * A {@link MediaDeviceEntry} that also says whether its label is the real device name.
 *
 * Absent `labelSource` means `'host'`.
 */
export interface LabelledMediaDeviceEntry extends MediaDeviceEntry {
    readonly labelSource?: MediaDeviceLabelSource;
}

/** Whether any of these entries is showing a stand-in name instead of the device's own. */
export function hasWithheldNames(entries: readonly MediaDeviceEntry[]): boolean {
    return entries.some(entry => (entry as LabelledMediaDeviceEntry).labelSource === 'placeholder');
}

/**
 * What this host can do about playback devices, which is what decides whether a speaker picker is
 * worth showing at all.
 */
export interface OutputSupport {
    /**
     * Whether the host lists output devices at all. When false, an empty
     * {@link MediaDeviceSource.outputs} must not be rendered as "no output devices".
     */
    readonly enumerable: boolean;

    /**
     * Whether playback can be routed to a chosen device. False without `setSinkId`. Gate the speaker
     * picker on this, never on the list being non-empty.
     */
    readonly selectable: boolean;
}

/**
 * Both true: the host enumerates outputs and can route playback to one. The desktop answer.
 *
 * Must stay a function, not an exported const: a const read from a class field initialiser comes
 * back `undefined` under the unit-test builder when this module lands in a shared chunk.
 */
export function fullOutputSupport(): OutputSupport {
    return {enumerable: true, selectable: true};
}

/** Neither: an empty output list from this host means nothing, and selection is impossible. */
export function noOutputSupport(): OutputSupport {
    return {enumerable: false, selectable: false};
}

/** Implemented by adapters whose answer to {@link MediaDeviceSource.outputs} needs a caveat. */
export interface OutputSupportReporting {
    outputSupport(): Promise<OutputSupport>;
}

/** Whether `source` reports its output limitations. */
export function reportsOutputSupport(source: unknown): source is OutputSupportReporting {
    return typeof (source as Partial<OutputSupportReporting> | null)?.outputSupport === 'function';
}

/** What `source` says about output devices, or {@link fullOutputSupport} if it says nothing. */
export async function outputSupportOf(source: MediaDeviceSource): Promise<OutputSupport> {
    if (!reportsOutputSupport(source)) return fullOutputSupport();
    try {
        return (await source.outputSupport()) ?? fullOutputSupport();
    } catch {
        // A report that cannot be produced must not take the enumeration down with it.
        return fullOutputSupport();
    }
}

/** `navigator.mediaDevices`, or undefined where there is no DOM (specs) or no support. */
export function navigatorMediaDevices(): MediaDevices | undefined {
    if (typeof navigator === 'undefined') return undefined;
    return navigator.mediaDevices;
}

/**
 * Subscribes to "the set of devices changed" and returns its own teardown. Host-neutral:
 * `devicechange` is the signal on both hosts, and there is no Rust-side device-change event.
 */
export function onDeviceChange(handler: () => void, target?: EventTarget): () => void {
    const source = target ?? navigatorMediaDevices();
    if (!source?.addEventListener) return () => undefined;

    const listener = () => handler();
    source.addEventListener('devicechange', listener);
    return () => source.removeEventListener('devicechange', listener);
}
