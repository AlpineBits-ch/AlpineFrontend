/**
 * The catalog's job is to be the one place that asks the host what is plugged in.
 *
 * <p>What is worth pinning here is the failure mode, because it is silent: enumeration throws in the
 * browser build, where there is no Rust side at all, and a consumer that assumed a populated list
 * would render an empty dropdown with no explanation. Empty has to be a state the service reaches
 * deliberately, not one it falls into.</p>
 */
// A spy rather than a fixed arrow: several spec files mock this module and only one registration
// wins per run, so the values are set per test below. See the same note in game-catalog.service.spec.ts.
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn().mockResolvedValue([]),
    isTauri: vi.fn(() => true),
}));

import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {invoke} from '@tauri-apps/api/core';
import {MediaDeviceCatalogService} from './media-device-catalog.service';

const MICS = [{id: 'Headset (A50)', name: 'Headset (A50)', isDefault: true}];
const SPEAKERS = [{id: 'Speakers (Realtek)', name: 'Speakers (Realtek)', isDefault: false}];

/** Routes each Tauri command to its own answer, since both are asked for in one Promise.all. */
function respondWith(mics: unknown, speakers: unknown): void {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
        if (cmd === 'enumerate_audio_devices') return Promise.resolve(mics) as never;
        if (cmd === 'enumerate_output_devices') return Promise.resolve(speakers) as never;
        return Promise.resolve(undefined) as never;
    });
}

function create(): MediaDeviceCatalogService {
    TestBed.configureTestingModule({providers: [provideZonelessChangeDetection()]});
    return TestBed.inject(MediaDeviceCatalogService);
}

describe('MediaDeviceCatalogService', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        vi.mocked(invoke).mockReset();
        respondWith(MICS, SPEAKERS);
    });

    it('turns both device lists into label/value options', async () => {
        const service = create();
        await service.refresh();

        expect(service.mics()).toEqual([{label: 'Headset (A50)', value: 'Headset (A50)'}]);
        expect(service.speakers()).toEqual([{label: 'Speakers (Realtek)', value: 'Speakers (Realtek)'}]);
    });

    it('asks the host for both kinds', async () => {
        const service = create();
        await service.refresh();

        expect(invoke).toHaveBeenCalledWith('enumerate_audio_devices');
        expect(invoke).toHaveBeenCalledWith('enumerate_output_devices');
    });

    /** The browser build has no Rust side. Empty lists, not a thrown promise. */
    it('empties both lists when enumeration fails', async () => {
        const service = create();
        await service.refresh();
        expect(service.mics()).not.toEqual([]);

        vi.mocked(invoke).mockRejectedValue(new Error('no tauri'));
        await service.refresh();

        expect(service.mics()).toEqual([]);
        expect(service.speakers()).toEqual([]);
    });

    it('does not reject when enumeration fails', async () => {
        vi.mocked(invoke).mockRejectedValue(new Error('no tauri'));
        const service = create();

        await expect(service.refresh()).resolves.toBeUndefined();
    });

    /** Two menus opening at once should cost one round trip, not two. */
    it('shares one round trip between concurrent refreshes', async () => {
        const service = create();
        // The constructor already started one. Let it settle first, or these three would simply
        // join it and the test would pass without exercising the coalescing at all.
        await service.refresh();
        vi.mocked(invoke).mockClear();

        await Promise.all([service.refresh(), service.refresh(), service.refresh()]);

        expect(vi.mocked(invoke).mock.calls.filter(c => c[0] === 'enumerate_audio_devices')).toHaveLength(1);
    });

    it('reads the lists again once a refresh has settled', async () => {
        const service = create();
        await service.refresh();
        vi.mocked(invoke).mockClear();

        await service.refresh();

        expect(invoke).toHaveBeenCalledWith('enumerate_audio_devices');
    });

    it('refreshes when the machine gains or loses a device', async () => {
        const service = create();
        await service.refresh();
        vi.mocked(invoke).mockClear();

        navigator.mediaDevices?.dispatchEvent?.(new Event('devicechange'));
        await service.refresh();

        expect(invoke).toHaveBeenCalledWith('enumerate_audio_devices');
    });
});
