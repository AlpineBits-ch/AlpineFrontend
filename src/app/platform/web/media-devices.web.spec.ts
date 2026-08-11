/**
 * The browser device catalog, and specifically the two states a well-formed device list never
 * reaches:
 *
 * <ul>
 *   <li><b>Blank labels.</b> `enumerateDevices()` hands back real ids and empty `label`s until the
 *       page holds a media permission. Feeding this adapter a nicely named list proves nothing about
 *       the case it exists for.</li>
 *   <li><b>Outputs it will not list.</b> An empty `audiooutput` list means "no speakers" in one engine
 *       and "ask someone else" in another, and the difference decides whether a picker is shown.</li>
 * </ul>
 *
 * <p>Plain-function spec: no TestBed, no injector. `MediaDevices` is supplied through the adapter's
 * options rather than by patching a global, because jsdom has no `navigator.mediaDevices` to patch.</p>
 */

import {describe, expect, it, vi} from 'vitest';
import {hasWithheldNames} from '../media-device-support';
import {DeviceEnumerator, WebMediaDeviceSource} from './media-devices.web';

class FakeEnumerator extends EventTarget implements DeviceEnumerator {
    calls = 0;
    result: MediaDeviceInfo[] | Error = [];

    constructor(devices: MediaDeviceInfo[] = []) {
        super();
        this.result = devices;
    }

    async enumerateDevices(): Promise<MediaDeviceInfo[]> {
        this.calls++;
        if (this.result instanceof Error) throw this.result;
        return this.result;
    }
}

function info(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
    return {deviceId, kind, label, groupId: `group-${deviceId}`, toJSON: () => ({})} as MediaDeviceInfo;
}

/** A source with a sink API present, so output support is not the thing under test. */
function sourceWith(devices: MediaDeviceInfo[]): {
    source: WebMediaDeviceSource;
    media: FakeEnumerator;
} {
    const media = new FakeEnumerator(devices);
    return {media, source: new WebMediaDeviceSource({mediaDevices: media, hasSinkApi: () => true})};
}

const NAMED = [
    info('audioinput', 'default', 'Default - Headset (A50)'),
    info('audioinput', 'mic-hash', 'Headset (A50)'),
    info('audiooutput', 'out-hash', 'Speakers (Realtek)'),
    info('videoinput', 'cam-hash', 'Integrated Camera'),
];

describe('WebMediaDeviceSource', () => {
    it('splits the enumeration by kind', async () => {
        const {source} = sourceWith(NAMED);

        expect(await source.inputs()).toEqual([
            {id: 'default', label: 'Default - Headset (A50)', isDefault: true, labelSource: 'host'},
            {id: 'mic-hash', label: 'Headset (A50)', isDefault: false, labelSource: 'host'},
        ]);
        expect(await source.outputs()).toEqual([
            {id: 'out-hash', label: 'Speakers (Realtek)', isDefault: false, labelSource: 'host'},
        ]);
        expect(await source.cameras()).toEqual([
            {id: 'cam-hash', label: 'Integrated Camera', isDefault: false, labelSource: 'host'},
        ]);
    });

    it('marks only a reported default as the default', async () => {
        const {source} = sourceWith([
            info('audioinput', 'mic-a', 'Mic A'),
            info('audioinput', 'mic-b', 'Mic B'),
        ]);

        // No engine reported a default, so no entry invents one. A wrongly marked default sends
        // audio to the wrong device; an unmarked list is merely unopinionated.
        expect((await source.inputs()).map(entry => entry.isDefault)).toEqual([false, false]);
    });

    it('drops the communications alias but keeps the default one', async () => {
        const {source} = sourceWith([
            info('audioinput', 'default', 'Default - Headset'),
            info('audioinput', 'communications', 'Communications - Headset'),
            info('audioinput', 'mic-hash', 'Headset'),
        ]);

        expect((await source.inputs()).map(entry => entry.id)).toEqual(['default', 'mic-hash']);
    });

    it('shares one enumeration between concurrent reads, and re-reads afterwards', async () => {
        const {source, media} = sourceWith(NAMED);

        await Promise.all([source.inputs(), source.outputs(), source.cameras()]);
        expect(media.calls).toBe(1);

        await source.inputs();
        expect(media.calls).toBe(2);
    });

    // ── Blank labels ────────────────────────────────────────────────────────

    it('names every device the browser refused to name', async () => {
        const {source} = sourceWith([
            info('audioinput', 'default', ''),
            info('audioinput', 'mic-one', ''),
            info('audioinput', 'mic-two', '   '),
            info('audiooutput', 'out-one', ''),
            info('videoinput', 'cam-one', ''),
        ]);

        const mics = await source.inputs();
        expect(mics).toEqual([
            {id: 'default', label: 'Default', isDefault: true, labelSource: 'placeholder'},
            {id: 'mic-one', label: 'Microphone 1', isDefault: false, labelSource: 'placeholder'},
            {id: 'mic-two', label: 'Microphone 2', isDefault: false, labelSource: 'placeholder'},
        ]);
        // Nothing renders blank, on any kind, and the noun follows the kind.
        expect(mics.every(entry => entry.label.trim().length > 0)).toBe(true);
        expect((await source.outputs())[0].label).toBe('Speaker 1');
        expect((await source.cameras())[0].label).toBe('Camera 1');
        expect(hasWithheldNames(mics)).toBe(true);
    });

    it('keeps the real names once permission has unblanked them', async () => {
        const {source, media} = sourceWith([info('audioinput', 'mic-one', '')]);
        expect((await source.inputs())[0].label).toBe('Microphone 1');

        // The same device, after getUserMedia was granted anywhere on the page.
        media.result = [info('audioinput', 'mic-one', 'Headset (A50)')];
        const named = await source.inputs();

        expect(named).toEqual([
            {id: 'mic-one', label: 'Headset (A50)', isDefault: false, labelSource: 'host'},
        ]);
        expect(hasWithheldNames(named)).toBe(false);
    });

    it('never asks for a media permission just to enumerate', async () => {
        const getUserMedia = vi.fn();
        const media = new FakeEnumerator([info('audioinput', 'mic-one', '')]) as FakeEnumerator & {
            getUserMedia: typeof getUserMedia;
        };
        media.getUserMedia = getUserMedia;
        const source = new WebMediaDeviceSource({mediaDevices: media, hasSinkApi: () => true});

        await Promise.all([source.inputs(), source.outputs(), source.cameras()]);

        // Opening a settings page must not raise a permission prompt as a side effect - and a denied
        // one would leave the labels blank anyway, which is what the stand-ins are for.
        expect(getUserMedia).not.toHaveBeenCalled();
    });

    // ── Outputs ─────────────────────────────────────────────────────────────

    it('reports no output support at all where there is no sink API', async () => {
        // Firefox before setSinkId: inputs enumerate perfectly well, outputs are simply absent.
        const media = new FakeEnumerator([info('audioinput', 'mic-one', 'Headset')]);
        const source = new WebMediaDeviceSource({mediaDevices: media, hasSinkApi: () => false});

        expect(await source.outputs()).toEqual([]);
        expect(await source.outputSupport()).toEqual({enumerable: false, selectable: false});
        // And the inputs still work, so this is not read as "no devices".
        expect(await source.inputs()).toHaveLength(1);
    });

    it('reports full support where a sink API exists, so an empty list means no speakers', async () => {
        const {source} = sourceWith([info('audioinput', 'mic-one', 'Headset')]);

        expect(await source.outputs()).toEqual([]);
        expect(await source.outputSupport()).toEqual({enumerable: true, selectable: true});
    });

    // ── No mediaDevices, and a refusing one ─────────────────────────────────

    it('answers empty, and reports it cannot enumerate, with no mediaDevices at all', async () => {
        const source = new WebMediaDeviceSource({hasSinkApi: () => true});
        // jsdom has no navigator.mediaDevices, which is exactly the context being described.

        expect(await source.inputs()).toEqual([]);
        expect(await source.outputs()).toEqual([]);
        expect(await source.cameras()).toEqual([]);
        expect(await source.outputSupport()).toEqual({enumerable: false, selectable: true});
    });

    it('answers empty rather than rejecting when enumerateDevices throws', async () => {
        const {source, media} = sourceWith([]);
        media.result = new Error('not allowed');

        await expect(source.inputs()).resolves.toEqual([]);
    });

    it('shares no in-flight promise past a failure', async () => {
        const {source, media} = sourceWith([]);
        media.result = new Error('not allowed');
        await source.inputs();

        media.result = [info('audioinput', 'mic-one', 'Headset')];

        expect(await source.inputs()).toHaveLength(1);
    });

    // ── Change notification ─────────────────────────────────────────────────

    it('forwards devicechange and stops on unsubscribe', () => {
        const {source, media} = sourceWith([]);
        const handler = vi.fn();

        const stop = source.onChange(handler);
        media.dispatchEvent(new Event('devicechange'));
        expect(handler).toHaveBeenCalledTimes(1);

        stop();
        media.dispatchEvent(new Event('devicechange'));
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('returns a usable teardown even with nothing to subscribe to', () => {
        const source = new WebMediaDeviceSource();

        expect(() => source.onChange(() => undefined)()).not.toThrow();
    });
});
