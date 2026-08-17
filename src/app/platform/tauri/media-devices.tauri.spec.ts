/**
 * The desktop adapter is a mapping, and the mapping is where information gets lost: the Rust
 * commands answer with `{id, name, isDefault?}` and the port wants `{id, label, isDefault}`. What is
 * pinned here is that `name` becomes the label rather than being flattened away, that `id` stays the
 * cpal device *name* the capture pipeline looks devices up by, and that a missing `isDefault` is read
 * as false rather than invented.
 */

// A spy rather than a fixed arrow: several spec files mock this module and only one registration
// wins per run, so the values are set per test below. See the same note in game-catalog.service.spec.ts.
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn().mockResolvedValue([]),
    isTauri: vi.fn(() => true),
}));

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import {TauriMediaDeviceSource} from './media-devices.tauri';

/** What the Rust side actually returns, including the synthetic default entry it prepends. */
const MICS = [
    {id: 'default', name: 'Default', isDefault: true},
    {id: 'Headset (2- A50 Game)', name: 'Headset (2- A50 Game)', isDefault: false},
];
const SPEAKERS = [{id: 'default', name: 'Default', isDefault: true}];
const CAMERAS = [{id: '0', name: 'Integrated Camera'}];

function respond(): void {
    vi.mocked(invoke).mockImplementation((command: string) => {
        if (command === 'enumerate_audio_devices') return Promise.resolve(MICS) as never;
        if (command === 'enumerate_output_devices') return Promise.resolve(SPEAKERS) as never;
        if (command === 'enumerate_camera_devices') return Promise.resolve(CAMERAS) as never;
        return Promise.resolve(undefined) as never;
    });
}

describe('TauriMediaDeviceSource', () => {
    beforeEach(() => {
        vi.mocked(invoke).mockReset();
        respond();
    });

    it('maps the audio commands onto port entries', async () => {
        const source = new TauriMediaDeviceSource();

        expect(await source.inputs()).toEqual([
            {id: 'default', label: 'Default', isDefault: true},
            {id: 'Headset (2- A50 Game)', label: 'Headset (2- A50 Game)', isDefault: false},
        ]);
        expect(await source.outputs()).toEqual([{id: 'default', label: 'Default', isDefault: true}]);
        expect(invoke).toHaveBeenCalledWith('enumerate_audio_devices');
        expect(invoke).toHaveBeenCalledWith('enumerate_output_devices');
    });

    it('maps cameras, which report no default', async () => {
        const source = new TauriMediaDeviceSource();

        expect(await source.cameras()).toEqual([
            {id: '0', label: 'Integrated Camera', isDefault: false},
        ]);
        expect(invoke).toHaveBeenCalledWith('enumerate_camera_devices');
    });

    it('reads a missing isDefault as false rather than inventing one', async () => {
        vi.mocked(invoke).mockResolvedValue([{id: 'Mic', name: 'Mic'}] as never);
        const source = new TauriMediaDeviceSource();

        expect(await source.inputs()).toEqual([{id: 'Mic', label: 'Mic', isDefault: false}]);
    });

    /** Desktop playback opens the cpal device by id, so selection does not depend on `setSinkId`. */
    it('reports full output support', async () => {
        expect(await new TauriMediaDeviceSource().outputSupport())
            .toEqual({enumerable: true, selectable: true});
    });

    /** The catalog decides what an unavailable list means; the adapter does not swallow it. */
    it('propagates a failed command', async () => {
        vi.mocked(invoke).mockRejectedValue(new Error('no tauri'));

        await expect(new TauriMediaDeviceSource().inputs()).rejects.toThrow('no tauri');
    });
});
