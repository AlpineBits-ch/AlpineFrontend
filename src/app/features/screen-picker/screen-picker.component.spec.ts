/** The pre-share dialog, after the quality step was taken out of it. */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {ScreenPickerComponent} from './screen-picker.component';
import {ScreenPickerChoice} from '../../services/screen-picker.service';
import {RustMediaService, ScreenSource} from '../../services/rust-media.service';
import {PlatformCapabilities, tauriCapabilities} from '../../platform/capabilities';
import {StreamPreset} from '../../models/stream-preset';
import {installMemoryStorage} from '../../testing/memory-storage';

const PRESET_KEY = 'alpine_stream_preset';

const MONITOR: ScreenSource = {
    id: 'monitor:0',
    name: 'Display 1',
    isMonitor: true,
    thumbnail: '',
    width: 2560,
    height: 1440,
};

const WINDOW: ScreenSource = {
    id: 'window:7',
    name: 'Helldivers 2',
    isMonitor: false,
    thumbnail: '',
    width: 1920,
    height: 1080,
};

const SOURCES = [MONITOR, WINDOW];

function render(): ComponentFixture<ScreenPickerComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [ScreenPickerComponent, TranslateModule.forRoot()],
        providers: [
            {
                provide: RustMediaService,
                useValue: {
                    getScreenSources: () => Promise.resolve(SOURCES),
                    captureSourceThumbnails: () => Promise.resolve([]),
                },
            },
            {provide: PlatformCapabilities, useValue: tauriCapabilities()},
        ],
    });

    const fixture = TestBed.createComponent(ScreenPickerComponent);
    fixture.componentInstance.picker.visible.set(true);
    fixture.componentInstance.picker.sources.set(SOURCES);
    fixture.detectChanges();
    return fixture;
}

/** Open the dialog and render it with the list already in. */
function open(fixture: ComponentFixture<ScreenPickerComponent>): Promise<unknown> {
    const pending = fixture.componentInstance.picker.show();
    fixture.componentInstance.picker.sources.set(SOURCES);
    fixture.componentInstance.picker.loading.set(false);
    fixture.detectChanges();
    return pending;
}

/** The source tiles of the tab currently on screen. */
function tiles(fixture: ComponentFixture<ScreenPickerComponent>): HTMLButtonElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.grid button')) as HTMLButtonElement[];
}

function save(preset: StreamPreset): void {
    localStorage.setItem(PRESET_KEY, JSON.stringify(preset));
}

describe('the pre-share dialog', () => {
    let restoreStorage: () => void;

    beforeEach(() => (restoreStorage = installMemoryStorage()));
    afterEach(() => restoreStorage());

    /** The whole point of the refactor: one click, no Next, no Go Live. */
    it('publishes on the click that picks a source', async () => {
        const fixture = render();
        const pending = open(fixture);

        tiles(fixture)[0].click();

        const choice = (await pending) as ScreenPickerChoice;
        expect(choice.sourceId).toBe('monitor:0');
        expect(choice.sourceWidth).toBe(2560);
        expect(choice.sourceHeight).toBe(1440);
        expect(fixture.componentInstance.picker.visible()).toBe(false);
    });

    /** There is no second step to confirm on, so nothing may be left standing between the two. */
    it('draws no confirmation controls', () => {
        const fixture = render();
        const labels = Array.from(fixture.nativeElement.querySelectorAll('button')).map(b =>
            (b as HTMLButtonElement).textContent?.trim(),
        );

        expect(labels).not.toContain('Next');
        expect(labels).not.toContain('Go Live');
        expect(labels).not.toContain('Back');
        expect(fixture.nativeElement.querySelector('[data-testid="resolution-options"]')).toBeNull();
        expect(fixture.nativeElement.querySelector('[data-testid="framerate-options"]')).toBeNull();
    });

    /** The quality the bar was last left at, which is now the only place quality is chosen. */
    it('opens the share at the remembered preset', async () => {
        save({resolution: '720p', framerate: 15, content: 'text'});
        const fixture = render();
        const pending = open(fixture);

        tiles(fixture)[0].click();

        expect(((await pending) as ScreenPickerChoice).preset).toEqual({
            resolution: '720p',
            framerate: 15,
            content: 'text',
        });
    });

    /** Passed through as stored, never clamped here. */
    it('does not clamp the stored preference against the room', async () => {
        save({resolution: '1440p', framerate: 60, content: 'text'});
        const fixture = render();
        const pending = open(fixture);

        tiles(fixture)[0].click();

        expect(((await pending) as ScreenPickerChoice).preset).toEqual({
            resolution: '1440p',
            framerate: 60,
            content: 'text',
        });
        expect(JSON.parse(localStorage.getItem(PRESET_KEY)!)).toEqual({
            resolution: '1440p',
            framerate: 60,
            content: 'text',
        });
    });

    /**
     * The one setting that survived, and the reason it did: `shareAudio: false` publishes no audio
     * track, and the in-call mute button needs a track to mute. It cannot be undone after the fact.
     */
    it('asks for audio by default', async () => {
        const fixture = render();
        const pending = open(fixture);

        tiles(fixture)[0].click();

        expect(((await pending) as ScreenPickerChoice).shareAudio).toBe(true);
    });

    it('carries the audio checkbox into the share when it is cleared', async () => {
        const fixture = render();
        const pending = open(fixture);

        // Clicked rather than set, so the binding between the box and the choice is what is under
        // test - the signal on its own would pass with the checkbox wired to nothing.
        const box = fixture.nativeElement.querySelector('#share-system-audio') as HTMLInputElement;
        box.click();
        fixture.detectChanges();
        expect(fixture.componentInstance.shareAudio()).toBe(false);

        tiles(fixture)[0].click();

        expect(((await pending) as ScreenPickerChoice).shareAudio).toBe(false);
    });

    /**
     * The activity hint used to select the matching window, which was safe while a selection still
     * needed a Go Live behind it. A click is a publish now, so the hint may only suggest.
     */
    it('suggests the hinted window without sharing it', () => {
        const fixture = render();
        let published = false;
        void open(fixture).then(() => (published = true));

        fixture.componentInstance.picker.preferredSourceId.set('window:7');
        fixture.detectChanges();

        expect(fixture.componentInstance.activeTab()).toBe('windows');
        expect(fixture.componentInstance.suggestedSourceId()).toBe('window:7');
        expect(published).toBe(false);
    });
});
