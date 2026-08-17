import {TestBed} from '@angular/core/testing';
import {AudioSettingsService} from './audio-settings.service';
import {installMemoryStorage} from '../testing/memory-storage';

const KEY = 'alpine_audio_settings';

function load(): AudioSettingsService {
    TestBed.resetTestingModule();
    return TestBed.inject(AudioSettingsService);
}

describe('AudioSettingsService migration', () => {
    let restoreStorage: () => void;

    beforeEach(() => (restoreStorage = installMemoryStorage()));
    afterEach(() => restoreStorage());

    it('drops the removed bitrate keys', () => {
        localStorage.setItem(
            KEY,
            JSON.stringify({
                audioBitrate: 320,
                screenAudioBitrate: 510,
                videoBitrate: 8000,
                screenVideoBitrate: 15000,
            }),
        );
        const settings = load().settings() as unknown as Record<string, unknown>;
        expect(settings['audioBitrate']).toBeUndefined();
        expect(settings['screenAudioBitrate']).toBeUndefined();
        expect(settings['videoBitrate']).toBeUndefined();
        expect(settings['screenVideoBitrate']).toBeUndefined();
    });

    it('drops the legacy noise-suppression toggles', () => {
        localStorage.setItem(KEY, JSON.stringify({noiseSuppression: true, enhancedNoiseSuppression: true}));
        const settings = load().settings() as unknown as Record<string, unknown>;
        expect(settings['noiseSuppression']).toBeUndefined();
        expect(settings['enhancedNoiseSuppression']).toBeUndefined();
    });

    it('folds the enhanced toggle into the enhanced mode', () => {
        localStorage.setItem(KEY, JSON.stringify({noiseSuppression: true, enhancedNoiseSuppression: true}));
        expect(load().settings().noiseSuppressionMode).toBe('enhanced');
    });

    it('folds a plain noise-suppression toggle into the standard mode', () => {
        localStorage.setItem(KEY, JSON.stringify({noiseSuppression: true, enhancedNoiseSuppression: false}));
        expect(load().settings().noiseSuppressionMode).toBe('standard');
    });

    it('folds both toggles off into the none mode', () => {
        localStorage.setItem(KEY, JSON.stringify({noiseSuppression: false, enhancedNoiseSuppression: false}));
        expect(load().settings().noiseSuppressionMode).toBe('none');
    });

    it('prefers enhanced even when the plain toggle was off', () => {
        localStorage.setItem(KEY, JSON.stringify({noiseSuppression: false, enhancedNoiseSuppression: true}));
        expect(load().settings().noiseSuppressionMode).toBe('enhanced');
    });

    it('defaults the new volume keys to 100', () => {
        localStorage.setItem(KEY, JSON.stringify({micId: 'mic-1'}));
        const settings = load().settings();
        expect(settings.inputVolume).toBe(100);
        expect(settings.outputVolume).toBe(100);
    });

    it('keeps unrelated settings intact', () => {
        localStorage.setItem(
            KEY,
            JSON.stringify({micId: 'mic-1', inputMode: 'push-to-talk', vadStrength: 0.5}),
        );
        const settings = load().settings();
        expect(settings.micId).toBe('mic-1');
        expect(settings.inputMode).toBe('push-to-talk');
        expect(settings.vadStrength).toBe(0.5);
    });

    it('is idempotent across a save and a reload', () => {
        localStorage.setItem(KEY, JSON.stringify({noiseSuppression: true, enhancedNoiseSuppression: true}));
        load().update({micId: 'mic-2'});

        const settings = load().settings() as unknown as Record<string, unknown>;
        expect(settings['noiseSuppressionMode']).toBe('enhanced');
        expect(settings['micId']).toBe('mic-2');
        expect(settings['enhancedNoiseSuppression']).toBeUndefined();
    });

    it('falls back to defaults on unparseable storage', () => {
        localStorage.setItem(KEY, 'not json');
        expect(load().settings().noiseSuppressionMode).toBe('standard');
    });
});

describe('AudioSettingsService.buildAudioConstraint', () => {
    let restoreStorage: () => void;

    beforeEach(() => (restoreStorage = installMemoryStorage()));
    afterEach(() => restoreStorage());

    it('enables the browser filter only in standard mode', async () => {
        localStorage.setItem(KEY, JSON.stringify({noiseSuppressionMode: 'standard'}));
        await expect(load().buildAudioConstraint()).resolves.toMatchObject({noiseSuppression: true});
    });

    it('leaves the browser filter off in enhanced mode, where Rust handles it', async () => {
        localStorage.setItem(KEY, JSON.stringify({noiseSuppressionMode: 'enhanced'}));
        await expect(load().buildAudioConstraint()).resolves.toMatchObject({noiseSuppression: false});
    });

    it('leaves the browser filter off in none mode', async () => {
        localStorage.setItem(KEY, JSON.stringify({noiseSuppressionMode: 'none'}));
        await expect(load().buildAudioConstraint()).resolves.toMatchObject({noiseSuppression: false});
    });
});
