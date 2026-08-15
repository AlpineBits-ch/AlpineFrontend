import {TestBed} from '@angular/core/testing';
import {ScreenPickerService} from './screen-picker.service';
import {RustMediaService} from './rust-media.service';
import {installMemoryStorage} from '../testing/memory-storage';
import {PlatformCapabilities, tauriCapabilities, webCapabilities} from '../platform/capabilities';

const PRESET_KEY = 'alpine_stream_preset';

/**
 * The capabilities are <b>provided</b> rather than inferred from the environment.
 *
 * <p>`detectHost()` answers 'web' under the test runner, so without this every test here would exercise
 * the host-picker path and the overlay would never open. Which picker is in play is the whole subject of
 * the last describe below, so it has to be an input, not an accident of where the suite runs.</p>
 */
function picker(capabilities: PlatformCapabilities = tauriCapabilities()): ScreenPickerService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            {provide: RustMediaService, useValue: {getScreenSources: () => Promise.resolve([])}},
            {provide: PlatformCapabilities, useValue: capabilities},
        ],
    });
    return TestBed.inject(ScreenPickerService);
}

describe('ScreenPickerService', () => {
    let restoreStorage: () => void;

    beforeEach(() => restoreStorage = installMemoryStorage());
    afterEach(() => restoreStorage());

    it('resolves with the chosen source, preset and audio flag', async () => {
        const svc = picker();
        const pending = svc.show();
        svc.select({
            sourceId: 'monitor:0',
            sourceWidth: 2560,
            sourceHeight: 1440,
            preset: {resolution: '1440p', framerate: 60},
            shareAudio: true,
        });
        await expect(pending).resolves.toEqual({
            sourceId: 'monitor:0',
            sourceWidth: 2560,
            sourceHeight: 1440,
            preset: {resolution: '1440p', framerate: 60},
            shareAudio: true,
        });
        expect(svc.visible()).toBe(false);
    });

    it('resolves null when cancelled', async () => {
        const svc = picker();
        const pending = svc.show();
        svc.cancel();
        await expect(pending).resolves.toBeNull();
        expect(svc.visible()).toBe(false);
    });

    it('remembers the last preset across instances', () => {
        const svc = picker();
        void svc.show();
        svc.select({
            sourceId: 'monitor:0',
            sourceWidth: 1920,
            sourceHeight: 1080,
            preset: {resolution: '720p', framerate: 15},
            shareAudio: false,
        });
        expect(picker().lastPreset()).toEqual({resolution: '720p', framerate: 15});
    });

    /**
     * The in-call quality bar's path. It is the only place a preset is chosen now - the pre-share
     * dialog stopped asking - so a change made there has to survive the share that was running when
     * it was made, or every share opens at the default however often the bar is used.
     */
    it('remembers a preset set outside the dialog', () => {
        picker().rememberPreset({resolution: '1440p', framerate: 60});

        expect(picker().lastPreset()).toEqual({resolution: '1440p', framerate: 60});
    });

    it('defaults to 1080p30 with no stored preset', () => {
        expect(picker().lastPreset()).toEqual({resolution: '1080p', framerate: 30});
    });

    it('falls back to the default preset on unparseable storage', () => {
        localStorage.setItem(PRESET_KEY, 'not json');
        expect(picker().lastPreset()).toEqual({resolution: '1080p', framerate: 30});
    });

    it('fills gaps in a partially stored preset', () => {
        localStorage.setItem(PRESET_KEY, JSON.stringify({resolution: '1440p'}));
        expect(picker().lastPreset()).toEqual({resolution: '1440p', framerate: 30});
    });
});

/**
 * Where the host owns the picker - a browser, where windows cannot be enumerated - this overlay is
 * skipped entirely and `getDisplayMedia` prompts instead, inside the publish.
 */
describe('ScreenPickerService without an in-app picker', () => {
    let restoreStorage: () => void;

    beforeEach(() => restoreStorage = installMemoryStorage());
    afterEach(() => restoreStorage());

    it('resolves immediately without showing the overlay', async () => {
        const svc = picker(webCapabilities());

        const choice = await svc.show();

        // Two pickers for one share is the failure here: this one must not appear at all.
        expect(svc.visible()).toBe(false);
        expect(choice).not.toBeNull();
    });

    /** No fabricated id: the publisher ignores it, and inventing one implies a source it could honour. */
    it('carries no source id', async () => {
        const choice = await picker(webCapabilities()).show();

        expect(choice?.sourceId).toBe('');
    });

    /**
     * The preset chooser still applies. Geometry is solved from it exactly as a desktop choice is, so a
     * stored preset has to survive into this path - otherwise "1080p at 30" stops meaning the same thing
     * across hosts.
     */
    it('uses the stored preset', async () => {
        localStorage.setItem(PRESET_KEY, JSON.stringify({resolution: '720p', framerate: 15}));

        const choice = await picker(webCapabilities()).show();

        expect(choice?.preset).toEqual({resolution: '720p', framerate: 15});
    });

    /** A box to solve against, taken from the display - and in device pixels, not CSS ones. */
    it('reports the primary display as the source dimensions', async () => {
        const choice = await picker(webCapabilities()).show();

        expect(choice?.sourceWidth).toBe(Math.round(window.screen.width * (window.devicePixelRatio || 1)));
        expect(choice?.sourceHeight).toBe(Math.round(window.screen.height * (window.devicePixelRatio || 1)));
    });

    /**
     * Requested, so the host picker puts its own "share audio" checkbox in front of the user. What was
     * actually published is answered afterwards, by the publisher.
     */
    it('asks for audio and lets the host decide', async () => {
        const choice = await picker(webCapabilities()).show();

        expect(choice?.shareAudio).toBe(true);
    });

    /** An activity hint cannot be honoured without a source list, so it is dropped rather than kept. */
    it('drops a source preference it cannot honour', async () => {
        const svc = picker(webCapabilities());
        svc.preferSourceFor('Some Game');

        await svc.show();

        expect(svc.preferredSourceId()).toBeNull();
    });
});
