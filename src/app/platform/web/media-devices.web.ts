import {MediaDeviceEntry, MediaDeviceSource} from '../ports/media-devices.port';
import {
    LabelledMediaDeviceEntry,
    noOutputSupport,
    navigatorMediaDevices,
    onDeviceChange,
    OutputSupport,
    OutputSupportReporting,
} from '../media-device-support';

/** The slice of `MediaDevices` this adapter uses. `MediaDevices` itself satisfies it. */
export interface DeviceEnumerator extends EventTarget {
    enumerateDevices(): Promise<MediaDeviceInfo[]>;
}

export interface WebMediaDeviceSourceOptions {
    /**
     * Stands in for `navigator.mediaDevices`.
     *
     * <p>Injectable for the same reason `openStore` takes an `IDBFactory`: jsdom has no
     * `mediaDevices` of its own, and the two states worth testing here - withheld labels, and a host
     * that will not list outputs - cannot be reached by mutating a global that does not exist.</p>
     */
    readonly mediaDevices?: DeviceEnumerator;

    /** Stands in for sink-API detection. See {@link WebMediaDeviceSource.outputSupport}. */
    readonly hasSinkApi?: () => boolean;
}

/** What a nameless device of each kind is called, when the browser will not say. */
const PLACEHOLDER_NOUNS: Record<MediaDeviceKind, string> = {
    audioinput: 'Microphone',
    audiooutput: 'Speaker',
    videoinput: 'Camera',
};

/**
 * Chromium's telephony alias. Filtered out.
 *
 * <p>It carries a copy of whichever device is currently the communications default, so in a picker it
 * is a second row that silently duplicates another one. `'default'` is deliberately <b>not</b>
 * filtered: it is the "follow the system default" choice a user actually wants, and it is the only
 * entry any browser marks as the default at all.</p>
 */
const ALIAS_ID = 'communications';

/**
 * The browser device catalog: one `enumerateDevices()` call, split by `kind`.
 *
 * <p><b>Labels.</b> `enumerateDevices()` returns real `deviceId`s and blank `label`s until the page
 * holds a media permission. Three things this adapter deliberately does not do about that: it does
 * not call `getUserMedia` (opening a settings page must not raise a permission prompt as a side
 * effect, and a denied prompt leaves the labels blank anyway), it does not drop the nameless entries
 * (they are real, selectable devices), and it does not render them blank. Each one gets a numbered
 * stand-in - "Microphone 2" - and is tagged {@link LabelledMediaDeviceEntry.labelSource}
 * `'placeholder'`, so a surface that wants to explain the state can, and every other caller just
 * sees readable labels. Once anything on the page has been granted a mic or camera, the real names
 * appear on the next refresh; `devicechange` and any menu open both trigger one.</p>
 *
 * <p><b>Defaults.</b> `isDefault` is true only for a `deviceId` of `'default'`, which is the only
 * default any engine reports. Where none is reported, no entry claims to be one - a picker with
 * nothing marked default is honest, and a wrongly marked one sends audio to the wrong device.</p>
 *
 * <p><b>Outputs.</b> See {@link outputSupport}: an empty output list here does not always mean "no
 * speakers", and this adapter says which it is instead of guessing.</p>
 */
export class WebMediaDeviceSource extends MediaDeviceSource implements OutputSupportReporting {
    /** The enumeration in flight, so `inputs()` and `outputs()` in one `Promise.all` cost one call. */
    private inFlight: Promise<MediaDeviceInfo[]> | null = null;

    constructor(private readonly options: WebMediaDeviceSourceOptions = {}) {
        super();
    }

    async inputs(): Promise<MediaDeviceEntry[]> {
        return this.ofKind('audioinput');
    }

    async outputs(): Promise<MediaDeviceEntry[]> {
        return this.ofKind('audiooutput');
    }

    async cameras(): Promise<MediaDeviceEntry[]> {
        return this.ofKind('videoinput');
    }

    onChange(handler: () => void): () => void {
        return onDeviceChange(handler, this.enumerator());
    }

    /**
     * Whether this engine lists output devices, and whether playback can be pointed at one.
     *
     * <p><b>Both answers come from feature detection, not from the list being empty</b>, because an
     * empty list cannot tell "this machine has no speakers" from "this engine does not enumerate
     * outputs" - and Firefox is the second case while reporting inputs perfectly well.</p>
     *
     * <p>The detected feature is `setSinkId`, on `HTMLMediaElement` or on `AudioContext`. An engine
     * without it cannot route audio anywhere the user picks, so the picker is dead regardless of what
     * enumeration would have returned; the two facts collapse into one gate and this reports both as
     * false. Where `setSinkId` does exist, enumeration works, and an empty output list then really
     * does mean the machine has no output device - or that media permission has not been granted yet,
     * which travels separately as {@link LabelledMediaDeviceEntry.labelSource}.</p>
     */
    async outputSupport(): Promise<OutputSupport> {
        const selectable = (this.options.hasSinkApi ?? hasSinkApi)();
        if (!selectable) return noOutputSupport();
        return {enumerable: this.enumerator() !== undefined, selectable: true};
    }

    private async ofKind(kind: MediaDeviceKind): Promise<LabelledMediaDeviceEntry[]> {
        const devices = await this.list();
        const noun = PLACEHOLDER_NOUNS[kind];
        let nameless = 0;

        return devices
            .filter(device => device.kind === kind && device.deviceId !== ALIAS_ID)
            .map(device => {
                const label = device.label?.trim() ?? '';
                const isDefault = device.deviceId === 'default';
                if (label) {
                    return {id: device.deviceId, label, isDefault, labelSource: 'host' as const};
                }
                // The system-default entry can be named without knowing the device behind it, and
                // "Default" describes what selecting it does. Everything else gets a number - and
                // only those consume one, or a list led by "Default" would start at "Microphone 2".
                const named = isDefault || !device.deviceId;
                if (!named) nameless += 1;
                return {
                    id: device.deviceId,
                    label: named ? 'Default' : `${noun} ${nameless}`,
                    isDefault,
                    labelSource: 'placeholder' as const,
                };
            });
    }

    /** One enumeration, shared by concurrent callers. Never cached past settling. */
    private list(): Promise<MediaDeviceInfo[]> {
        const enumerator = this.enumerator();
        if (!enumerator) return Promise.resolve([]);

        this.inFlight ??= enumerator
            .enumerateDevices()
            .catch((error: unknown) => {
                console.warn('[media-devices] enumerateDevices failed', error);
                return [] as MediaDeviceInfo[];
            })
            .finally(() => {
                this.inFlight = null;
            });

        return this.inFlight;
    }

    private enumerator(): DeviceEnumerator | undefined {
        const supplied = this.options.mediaDevices;
        if (supplied) return supplied;
        const media = navigatorMediaDevices();
        return typeof media?.enumerateDevices === 'function' ? media : undefined;
    }
}

/** Whether anything in this engine can route playback to a chosen device. */
function hasSinkApi(): boolean {
    const onMedia = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
    const onContext = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
    return onMedia || onContext;
}
