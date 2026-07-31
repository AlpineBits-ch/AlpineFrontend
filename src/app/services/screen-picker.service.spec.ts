import {TestBed} from '@angular/core/testing';
import {ScreenPickerService} from './screen-picker.service';
import {RustMediaService} from './rust-media.service';
import {installMemoryStorage} from '../testing/memory-storage';

const PRESET_KEY = 'alpine_stream_preset';

function picker(): ScreenPickerService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [{provide: RustMediaService, useValue: {getScreenSources: () => Promise.resolve([])}}],
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
