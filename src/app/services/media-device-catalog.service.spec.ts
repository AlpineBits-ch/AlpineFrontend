/**
 * The catalog's job is to be the one place that asks the host what is plugged in.
 *
 * <p>What is worth pinning here is the failure modes, because all three are silent: enumeration can
 * fail outright, a browser can withhold every device *name* until it holds a media permission, and a
 * browser can refuse to list output devices at all. A consumer that assumed a populated, named,
 * complete list renders an empty dropdown, five nameless microphones, or "you have no speakers" - and
 * none of those is a state this service should be able to fall into by accident.</p>
 *
 * <p>No `vi.mock('@tauri-apps/api/core')` here any more: the host lives behind
 * {@link MediaDeviceSource} and this spec provides a fake adapter, which is what lets it exercise the
 * browser-only states above at all.</p>
 */

import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {MediaDeviceEntry, MediaDeviceSource} from '../platform/ports/media-devices.port';
import {
    LabelledMediaDeviceEntry,
    OutputSupport,
    OutputSupportReporting,
} from '../platform/media-device-support';
import {MediaDeviceCatalogService} from './media-device-catalog.service';

/**
 * The two output-support answers, as literals.
 *
 * <p>Declared here rather than imported from `media-device-support`: the fake below reads one from a
 * class field initialiser, and an <i>imported</i> binding read from that position resolves to
 * `undefined` whenever the unit-test builder puts the module in a chunk shared with another spec entry
 * point. Asserting against literals is also the stronger test - it pins the contract rather than
 * comparing the code to itself.</p>
 */
const FULL_SUPPORT: OutputSupport = {enumerable: true, selectable: true};
const NO_SUPPORT: OutputSupport = {enumerable: false, selectable: false};

const MICS: LabelledMediaDeviceEntry[] = [
    {id: 'Headset (A50)', label: 'Headset (A50)', isDefault: true, labelSource: 'host'},
];
const SPEAKERS: LabelledMediaDeviceEntry[] = [
    {id: 'Speakers (Realtek)', label: 'Speakers (Realtek)', isDefault: false, labelSource: 'host'},
];

/** A stand-in host. Every state the real adapters can be in is reachable by assigning a field. */
class FakeMediaDeviceSource extends MediaDeviceSource implements OutputSupportReporting {
    micList: LabelledMediaDeviceEntry[] = MICS;
    speakerList: LabelledMediaDeviceEntry[] = SPEAKERS;
    cameraList: LabelledMediaDeviceEntry[] = [];
    support: OutputSupport = FULL_SUPPORT;
    /** When set, both enumerations reject - the "there is no host here" case. */
    failure: Error | null = null;
    readonly calls = {inputs: 0, outputs: 0, cameras: 0};

    private readonly listeners = new Set<() => void>();

    async inputs(): Promise<MediaDeviceEntry[]> {
        this.calls.inputs++;
        if (this.failure) throw this.failure;
        return this.micList;
    }

    async outputs(): Promise<MediaDeviceEntry[]> {
        this.calls.outputs++;
        if (this.failure) throw this.failure;
        return this.speakerList;
    }

    async cameras(): Promise<MediaDeviceEntry[]> {
        this.calls.cameras++;
        if (this.failure) throw this.failure;
        return this.cameraList;
    }

    onChange(handler: () => void): () => void {
        this.listeners.add(handler);
        return () => this.listeners.delete(handler);
    }

    async outputSupport(): Promise<OutputSupport> {
        return this.support;
    }

    /** A headset being plugged in. */
    emitChange(): void {
        for (const listener of [...this.listeners]) listener();
    }
}

/** A conforming adapter that reports no caveats at all, like the desktop one used to. */
class SilentMediaDeviceSource extends MediaDeviceSource {
    async inputs(): Promise<MediaDeviceEntry[]> {
        return MICS;
    }

    async outputs(): Promise<MediaDeviceEntry[]> {
        return [];
    }

    async cameras(): Promise<MediaDeviceEntry[]> {
        return [];
    }

    onChange(): () => void {
        return () => undefined;
    }
}

function create(source: MediaDeviceSource): MediaDeviceCatalogService {
    TestBed.configureTestingModule({
        providers: [provideZonelessChangeDetection(), {provide: MediaDeviceSource, useValue: source}],
    });
    return TestBed.inject(MediaDeviceCatalogService);
}

describe('MediaDeviceCatalogService', () => {
    let host: FakeMediaDeviceSource;

    beforeEach(() => {
        TestBed.resetTestingModule();
        host = new FakeMediaDeviceSource();
    });

    it('turns both device lists into label/value options', async () => {
        const service = create(host);
        await service.refresh();

        expect(service.mics()).toEqual([{label: 'Headset (A50)', value: 'Headset (A50)'}]);
        expect(service.speakers()).toEqual([{label: 'Speakers (Realtek)', value: 'Speakers (Realtek)'}]);
    });

    it('asks the host for both kinds', async () => {
        const service = create(host);
        await service.refresh();

        expect(host.calls.inputs).toBeGreaterThan(0);
        expect(host.calls.outputs).toBeGreaterThan(0);
    });

    /** No host at all - the pre-WASM browser build, or a refused command. Empty, not a rejection. */
    it('empties both lists when enumeration fails', async () => {
        const service = create(host);
        await service.refresh();
        expect(service.mics()).not.toEqual([]);

        host.failure = new Error('no host');
        await service.refresh();

        expect(service.mics()).toEqual([]);
        expect(service.speakers()).toEqual([]);
    });

    it('does not reject when enumeration fails', async () => {
        host.failure = new Error('no host');
        const service = create(host);

        await expect(service.refresh()).resolves.toBeUndefined();
    });

    /** One list failing must not blank the other. That conflation is what the port split fixed. */
    it('keeps the microphone list when only the output list fails', async () => {
        const service = create(host);
        // Let the constructor's refresh settle first: joining it would run the *working* outputs()
        // and the test would pass without ever reaching the failure.
        await service.refresh();

        host.outputs = async () => {
            throw new Error('outputs are not enumerable here');
        };
        await service.refresh();

        expect(service.mics()).toEqual([{label: 'Headset (A50)', value: 'Headset (A50)'}]);
        expect(service.speakers()).toEqual([]);
    });

    /** Two menus opening at once should cost one round trip, not two. */
    it('shares one round trip between concurrent refreshes', async () => {
        const service = create(host);
        // The constructor already started one. Let it settle first, or these three would simply
        // join it and the test would pass without exercising the coalescing at all.
        await service.refresh();
        const before = host.calls.inputs;

        await Promise.all([service.refresh(), service.refresh(), service.refresh()]);

        expect(host.calls.inputs - before).toBe(1);
    });

    it('reads the lists again once a refresh has settled', async () => {
        const service = create(host);
        await service.refresh();
        const before = host.calls.inputs;

        await service.refresh();

        expect(host.calls.inputs - before).toBe(1);
    });

    it('refreshes when the machine gains or loses a device', async () => {
        const service = create(host);
        await service.refresh();
        const before = host.calls.inputs;

        host.emitChange();
        await service.refresh();

        expect(host.calls.inputs - before).toBeGreaterThan(0);
    });

    // ── Withheld names ──────────────────────────────────────────────────────
    // A browser blanks every label until the page holds a media permission. The adapter substitutes
    // a readable stand-in; this service has to surface that a stand-in was used, or a settings page
    // shows "Microphone 1" and "Microphone 2" with no way to explain why.

    it('reports nothing withheld when the host named every device', async () => {
        const service = create(host);
        await service.refresh();

        expect(service.namesWithheld()).toBe(false);
    });

    it('reports withheld names when any entry is showing a stand-in', async () => {
        host.micList = [{id: 'a1b2', label: 'Microphone 1', isDefault: false, labelSource: 'placeholder'}];
        const service = create(host);
        await service.refresh();

        expect(service.namesWithheld()).toBe(true);
        // The stand-in still has to be a usable option: a blank label is the bug being avoided.
        expect(service.mics()).toEqual([{label: 'Microphone 1', value: 'a1b2'}]);
    });

    it('stops reporting withheld names once permission unblanks the labels', async () => {
        host.micList = [{id: 'a1b2', label: 'Microphone 1', isDefault: false, labelSource: 'placeholder'}];
        const service = create(host);
        await service.refresh();
        expect(service.namesWithheld()).toBe(true);

        host.micList = [{id: 'a1b2', label: 'Headset (A50)', isDefault: false, labelSource: 'host'}];
        await service.refresh();

        expect(service.namesWithheld()).toBe(false);
    });

    // ── No outputs vs no output *support* ───────────────────────────────────
    // `speakers()` is empty in both cases. The difference decides whether the picker is shown with
    // "no output devices" or hidden because this browser cannot route audio anywhere anyway.

    it('separates a browser that will not list outputs from a machine with none', async () => {
        host.speakerList = [];
        host.support = NO_SUPPORT;
        const service = create(host);
        await service.refresh();

        expect(service.speakers()).toEqual([]);
        expect(service.outputSupport()).toEqual({enumerable: false, selectable: false});
    });

    it('reports full support for an empty list on a host that does enumerate outputs', async () => {
        host.speakerList = [];
        const service = create(host);
        await service.refresh();

        // Same empty list as the test above, opposite meaning: this machine really has no speakers.
        expect(service.speakers()).toEqual([]);
        expect(service.outputSupport()).toEqual({enumerable: true, selectable: true});
    });

    it('treats an adapter that reports no caveats as fully capable', async () => {
        const service = create(new SilentMediaDeviceSource());
        await service.refresh();

        expect(service.outputSupport()).toEqual(FULL_SUPPORT);
        expect(service.namesWithheld()).toBe(false);
    });
});
