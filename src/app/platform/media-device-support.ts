import {MediaDeviceEntry, MediaDeviceSource} from './ports/media-devices.port';

/**
 * The two things a {@link MediaDeviceSource} has to be able to say that its three array-returning
 * methods cannot.
 *
 * <p><b>Why this is not on the port.</b> `MediaDeviceSource` is a settled contract, shared with the
 * voice and screen tracks, and its methods answer with a list. A list has no way to express "this
 * host will not tell me", and on the web that is a real and common state rather than an edge case:</p>
 *
 * <ul>
 *   <li>`enumerateDevices()` blanks every `label` until the page holds a media permission. Rendering
 *       those blanks is a settings page with five nameless microphones in it.</li>
 *   <li>`audiooutput` is not enumerable in every engine, and routing playback to a chosen output
 *       needs `setSinkId`, which is not universal either. An empty output list therefore means either
 *       "this machine has no speakers" or "this browser refuses to say", and those want different
 *       UI.</li>
 * </ul>
 *
 * <p>So both facts travel <i>alongside</i> the port rather than inside it: the label caveat as an
 * extra property on each entry ({@link LabelledMediaDeviceEntry}), and the output caveat as an
 * optional method an adapter may implement ({@link OutputSupportReporting}). Both are additive - a
 * consumer typed against `MediaDeviceEntry` and `MediaDeviceSource` compiles and behaves exactly as
 * before, and an adapter that reports nothing is read as fully capable, which is what the desktop
 * host has always been.</p>
 */

/** Where an entry's `label` came from. */
export type MediaDeviceLabelSource =
    /** The host named the device. */
    | 'host'
    /**
     * The host withheld the name and the adapter substituted a readable stand-in.
     *
     * <p>Nothing renders blank, and a surface that wants to explain why - "grant microphone access to
     * see device names" - can tell that it should.</p>
     */
    | 'placeholder';

/**
 * A {@link MediaDeviceEntry} that also says whether its label is the real device name.
 *
 * <p>Absent `labelSource` means `'host'`: the desktop adapter gets names from cpal, which never
 * withholds them.</p>
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
     * Whether the host lists output devices at all.
     *
     * <p>When this is false, an empty result from {@link MediaDeviceSource.outputs} carries no
     * information about the machine: there may well be speakers, and this host simply does not
     * enumerate them. Do not render that as "no output devices".</p>
     */
    readonly enumerable: boolean;

    /**
     * Whether playback can be routed to a chosen device.
     *
     * <p>False in an engine without `setSinkId`. A picker shown over this is a dead control - the
     * exact thing the design spec's capability rules exist to prevent - so gate it on this rather
     * than on the list being non-empty.</p>
     */
    readonly selectable: boolean;
}

/**
 * Both true: the host enumerates outputs and can route playback to one. The desktop answer.
 *
 * <p><b>A function rather than an exported const</b>, and that is not style. An imported const read
 * from a <i>class field initialiser</i> comes back `undefined` under the unit-test builder once the
 * module lands in a chunk shared between two spec entry points - the same binding read from a method
 * body, or from a closure, is fine. It cost an afternoon here: the initial value of
 * `MediaDeviceCatalogService.outputSupport` was `undefined` in any run that batched two of these specs
 * together and correct in every single-file run, which is the failure shape `vitest-base.config.ts`
 * documents from the other direction. Returning a fresh object also means no caller can mutate a
 * shared one.</p>
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

/**
 * What `source` says about output devices, or {@link fullOutputSupport} if it says nothing.
 *
 * <p>Silence is read as full support because that is the pre-port behaviour of every existing caller
 * and of the only host that existed before this one: the speaker picker was always shown, and on
 * desktop it always worked.</p>
 */
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
 * Subscribes to "the set of devices changed" and returns its own teardown.
 *
 * <p><b>Host-neutral on purpose.</b> `devicechange` is the signal on both hosts: Tauri runs a real
 * browser engine in its webview, and a headset that appears there is the same headset cpal will
 * enumerate a moment later. There is no Rust-side device-change event, and the pre-port catalog
 * already listened here while getting its lists from Tauri. Keeping this out of the adapters is also
 * what lets the lazy facade honour {@link MediaDeviceSource.onChange}'s synchronous contract without
 * having loaded an adapter yet.</p>
 */
export function onDeviceChange(handler: () => void, target?: EventTarget): () => void {
    const source = target ?? navigatorMediaDevices();
    if (!source?.addEventListener) return () => undefined;

    const listener = () => handler();
    source.addEventListener('devicechange', listener);
    return () => source.removeEventListener('devicechange', listener);
}
