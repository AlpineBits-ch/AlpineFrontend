import {Injectable} from '@angular/core';

/**
 * Translates the device identifiers stored in {@link AudioSettings} into the
 * origin-salted ids the Web media APIs actually accept.
 *
 * The pickers in voice/video settings are populated from Tauri
 * (`enumerate_audio_devices` / `enumerate_output_devices` / `enumerate_camera_devices`),
 * and those commands return the platform's *friendly name* as the `id`
 * -"Headphones (2- A50 Game)". That is the right key for the Rust capture path,
 * which looks devices up by cpal name, but it is meaningless to the Web APIs:
 * `getUserMedia({deviceId})`, `HTMLMediaElement.setSinkId` and
 * `AudioContext.setSinkId` only accept ids handed out by
 * `navigator.mediaDevices.enumerateDevices()`, which are per-origin hashes.
 *
 * Passing a name straight through therefore fails in two different ways:
 * `setSinkId` throws `NotFoundError: … the device Headphones (2- A50 Game) is not
 * found` (audio silently stays on the system default), while getUserMedia's
 * `{ideal: name}` is quietly ignored (you always get the default mic). So every
 * stored value has to be matched back to a live `MediaDeviceInfo` before use.
 *
 * On Windows both cpal and Chromium read the same MMDevice `PKEY_Device_FriendlyName`,
 * so labels line up exactly; the looser passes below cover camera backends that
 * decorate the name (nokhwa "Integrated Camera" vs Chromium "Integrated Camera (04f2:b6d9)").
 *
 * Caveat: `enumerateDevices()` blanks every label until media permission has been
 * granted. Resolution then finds nothing and callers fall back to the system
 * default -correct behaviour, and by the time voice is running `getUserMedia` has
 * already unlocked the labels.
 */
@Injectable({providedIn: 'root'})
export class MediaDeviceResolverService {
    /** Enumeration cache; dropped on `devicechange`. */
    private cache: MediaDeviceInfo[] | null = null;
    private inflight: Promise<MediaDeviceInfo[]> | null = null;

    constructor() {
        navigator.mediaDevices?.addEventListener('devicechange', () => {
            this.cache = null;
        });
    }

    /**
     * Resolve a stored device identifier to a live `MediaDeviceInfo.deviceId`.
     *
     * Accepts either an already-valid web device id or a legacy/Tauri device name.
     *
     * @returns the web device id, or `''` when the selection is "default" or no
     *   connected device matches -callers should treat `''` as "system default".
     */
    async toWebDeviceId(kind: MediaDeviceKind, stored: string): Promise<string> {
        if (!stored || stored === 'default') return '';

        const devices = (await this.list()).filter(d => d.kind === kind);
        if (!devices.length) return '';

        // Already a web id (the speaker/camera pickers may store one directly).
        if (devices.some(d => d.deviceId === stored)) return stored;

        const matched = matchByLabel(devices, stored);
        if (!matched) {
            console.warn(`[media-devices] no connected ${kind} matches "${stored}"; using the system default`);
        }
        return matched;
    }

    /** Enumerate once and share the result until the device list changes. */
    private async list(): Promise<MediaDeviceInfo[]> {
        if (this.cache) return this.cache;
        if (!navigator.mediaDevices?.enumerateDevices) return [];

        this.inflight ??= navigator.mediaDevices.enumerateDevices()
            .then(devices => {
                this.cache = devices;
                return devices;
            })
            .catch(e => {
                console.warn('[media-devices] enumerateDevices failed', e);
                return [] as MediaDeviceInfo[];
            })
            .finally(() => {
                this.inflight = null;
            });

        return this.inflight;
    }
}

/** Synthetic aliases Chromium exposes alongside the real devices. */
const ALIAS_IDS = new Set(['default', 'communications']);

/** Shortest label overlap we trust for a prefix match -guards against junk hits. */
const MIN_PARTIAL_LEN = 4;

function matchByLabel(devices: MediaDeviceInfo[], name: string): string {
    const wanted = normalise(name);
    if (!wanted) return '';

    // Prefer real devices: the synthetic "default"/"communications" entries carry a
    // copy of whichever device is currently system-default, so matching one of those
    // would silently re-follow the OS default instead of pinning the user's choice.
    const pools = [devices.filter(d => !ALIAS_IDS.has(d.deviceId)), devices];

    for (const pool of pools) {
        const exact = pool.find(d => normalise(d.label) === wanted);
        if (exact) return exact.deviceId;
    }

    for (const pool of pools) {
        const partial = pool.find(d => {
            const label = normalise(d.label);
            if (Math.min(label.length, wanted.length) < MIN_PARTIAL_LEN) return false;
            return label.startsWith(wanted) || wanted.startsWith(label);
        });
        if (partial) return partial.deviceId;
    }

    return '';
}

/** Strip Chromium's "Default - "/"Communications - " prefix and case/space noise. */
function normalise(label: string): string {
    return label.replace(/^(default|communications)\s*-\s*/i, '').trim().toLowerCase();
}
