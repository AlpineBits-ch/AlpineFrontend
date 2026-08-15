/**
 * The pre-share quality picker against a plan.
 *
 * <p>The in-call bar has stopped where the granted rung stops for a while; this dialog - the one the
 * quality is actually chosen in - offered all four resolutions and all three framerates to everybody,
 * and the choice was silently clamped later at publish. The user saw "2560 × 1440" on the quality
 * step and got 720p30, with nothing on either screen connecting the two.</p>
 *
 * <p>The shape mirrors the bar deliberately: options above the rung stay <b>drawn and disabled</b>,
 * never removed. A picker with fewer buttons on one server than on another says nothing about why.</p>
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {beforeEach, afterEach, describe, expect, it} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {ScreenPickerComponent} from './screen-picker.component';
import {RustMediaService, ScreenSource} from '../../services/rust-media.service';
import {VoiceLimitsService} from '../../services/voice-limits.service';
import {PlatformCapabilities, tauriCapabilities} from '../../platform/capabilities';
import {StreamPreset, VideoCeiling} from '../../models/stream-preset';
import {installMemoryStorage} from '../../testing/memory-storage';

const PRESET_KEY = 'alpine_stream_preset';

const SOURCE: ScreenSource = {
    id: 'monitor:0',
    name: 'Display 1',
    isMonitor: true,
    thumbnail: '',
    width: 2560,
    height: 1440,
};

/** 720p30 - the rung that permits 720p and 15/30 fps, and nothing above either. */
const RUNG_720P30: VideoCeiling = {maxHeight: 720, maxFramerate: 30};

/**
 * The dialog, already on its quality step.
 *
 * <p>The signals are set rather than the source-step buttons clicked: selecting a source starts a
 * live preview capture, which is a different subject and would drag the whole media stack into a
 * test about entitlements.</p>
 */
function render(ceiling = signal<VideoCeiling | null>(null)): {
    fixture: ComponentFixture<ScreenPickerComponent>;
    ceiling: typeof ceiling;
} {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [ScreenPickerComponent, TranslateModule.forRoot()],
        providers: [
            {
                provide: RustMediaService,
                useValue: {
                    getScreenSources: () => Promise.resolve([]),
                    startScreenCapture: () => Promise.reject(new Error('no capture in a unit test')),
                    stopScreenCapture: () => Promise.resolve(),
                },
            },
            {provide: PlatformCapabilities, useValue: tauriCapabilities()},
            {provide: VoiceLimitsService, useValue: {videoCeiling: ceiling}},
        ],
    });

    const fixture = TestBed.createComponent(ScreenPickerComponent);
    const component = fixture.componentInstance;
    component.picker.visible.set(true);
    component.selectedSource.set(SOURCE);
    component.step.set('quality');
    fixture.detectChanges();
    return {fixture, ceiling};
}

/** The segment buttons of one group. */
function segments(fixture: ComponentFixture<ScreenPickerComponent>, testid: string): HTMLButtonElement[] {
    const group = fixture.nativeElement.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
    return group ? Array.from(group.querySelectorAll('button')) : [];
}

function save(preset: StreamPreset): void {
    localStorage.setItem(PRESET_KEY, JSON.stringify(preset));
}

describe('the pre-share quality picker', () => {
    let restoreStorage: () => void;

    beforeEach(() => restoreStorage = installMemoryStorage());
    afterEach(() => restoreStorage());

    it('offers everything when no rung has been resolved', () => {
        const {fixture} = render();

        // Null is "nothing has said", which is not "no limits" - it is offered in full because the
        // server is the enforcement and a client-side clamp is only a courtesy.
        expect(segments(fixture, 'resolution-options').map(b => b.disabled))
            .toEqual([false, false, false, false]);
        expect(segments(fixture, 'framerate-options').map(b => b.disabled))
            .toEqual([false, false, false]);
    });

    it('stops where the granted rung stops, without removing the options', () => {
        const {fixture} = render(signal<VideoCeiling | null>(RUNG_720P30));

        const resolutions = segments(fixture, 'resolution-options');
        // 720p, 1080p, 1440p, Source - all four still drawn. Source survives whatever the ceiling
        // says: this client cannot know how tall the captured screen is, and guessing would be
        // making the pricing decision the server publishes a ladder to keep out of the client.
        expect(resolutions).toHaveLength(4);
        expect(resolutions.map(b => b.disabled)).toEqual([false, true, true, false]);
        expect(resolutions[1].getAttribute('title')).toBe('CALL.ABOVE_PLAN');
        expect(resolutions[0].getAttribute('title')).toBeNull();

        // 15 and 30 legal, 60 not: a lower framerate is always allowed on any rung above `none`.
        expect(segments(fixture, 'framerate-options').map(b => b.disabled))
            .toEqual([false, false, true]);
    });

    it('opens on a clamped preference rather than one the room cannot deliver', () => {
        save({resolution: '1440p', framerate: 60});
        const {fixture} = render(signal<VideoCeiling | null>(RUNG_720P30));
        const component = fixture.componentInstance;

        expect(component.resolution()).toBe('720p');
        expect(component.framerate()).toBe(30);
        // And the stated output geometry is the one the publish will actually produce.
        expect(component.outputLabel()).toBe('1280 × 720');
    });

    it('leaves a preference the rung does reach alone', () => {
        save({resolution: '720p', framerate: 15});
        const {fixture} = render(signal<VideoCeiling | null>(RUNG_720P30));

        expect(fixture.componentInstance.resolution()).toBe('720p');
        expect(fixture.componentInstance.framerate()).toBe(15);
    });

    /** The room's limits ride a snapshot, which can land while this dialog is already open. */
    it('follows a ceiling that arrives after it is open', () => {
        save({resolution: '1440p', framerate: 60});
        const {fixture, ceiling} = render();
        expect(fixture.componentInstance.resolution()).toBe('1440p');

        ceiling.set(RUNG_720P30);
        fixture.detectChanges();

        expect(fixture.componentInstance.resolution()).toBe('720p');
        expect(fixture.componentInstance.framerate()).toBe(30);
        expect(segments(fixture, 'resolution-options').map(b => b.disabled))
            .toEqual([false, true, true, false]);
    });

    /**
     * Negative: pressing a disabled option changes nothing. The `disabled` attribute already stops a
     * mouse, and this is what stops anything else - a synthetic click, a stray dispatch, a ceiling
     * that moved between the render and the press.
     */
    it('ignores a choice above the rung', () => {
        const {fixture} = render(signal<VideoCeiling | null>(RUNG_720P30));
        const component = fixture.componentInstance;

        component.chooseResolution('1440p');
        component.chooseFramerate(60);
        expect(component.resolution()).toBe('720p');
        expect(component.framerate()).toBe(30);

        component.chooseFramerate(15);
        expect(component.framerate()).toBe(15);
    });
});
