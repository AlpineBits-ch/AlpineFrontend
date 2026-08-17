import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal, WritableSignal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {NoiseSuppressionPopoverComponent} from './noise-suppression-popover.component';
import {AudioSettings, AudioSettingsService, DEFAULTS} from '../../../../services/audio-settings.service';
import {VoiceEngineService} from '../../../../services/voice-engine.service';

type Mode = AudioSettings['noiseSuppressionMode'];

interface Harness {
    fixture: ComponentFixture<NoiseSuppressionPopoverComponent>;
    component: NoiseSuppressionPopoverComponent;
    update: ReturnType<typeof vi.fn>;
    level: WritableSignal<number>;
    trigger: HTMLButtonElement;
    panel: () => HTMLElement | null;
    segments: () => HTMLButtonElement[];
}

function setup(mode: Mode = 'standard'): Harness {
    const settings = signal<AudioSettings>({...DEFAULTS, noiseSuppressionMode: mode});
    const update = vi.fn((patch: Partial<AudioSettings>) => settings.update(s => ({...s, ...patch})));
    const level = signal(0);

    TestBed.configureTestingModule({
        imports: [NoiseSuppressionPopoverComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            {provide: AudioSettingsService, useValue: {settings, update}},
            {provide: VoiceEngineService, useValue: {level}},
        ],
    });

    const fixture: ComponentFixture<NoiseSuppressionPopoverComponent> = TestBed.createComponent(
        NoiseSuppressionPopoverComponent,
    );
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    return {
        fixture,
        component: fixture.componentInstance,
        update,
        level,
        trigger: root.querySelector('[aria-label="VOICE_BAR.NOISE_SUPPRESSION"]') as HTMLButtonElement,
        panel: () => root.querySelector('[aria-label="VOICE_BAR.NOISE_SUPPRESSION"] ~ div'),
        segments: () => [...root.querySelectorAll('[aria-pressed]')] as HTMLButtonElement[],
    };
}

/** The trigger's own click has to reach the document listener the same way a real one does. */
function click(target: EventTarget): void {
    target.dispatchEvent(new MouseEvent('click', {bubbles: true}));
}

describe('NoiseSuppressionPopoverComponent opening and closing', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('starts closed', () => {
        const {panel} = setup();
        expect(panel()).toBeNull();
    });

    it('opens on the trigger and closes on a second press', () => {
        const {fixture, trigger, panel} = setup();

        click(trigger);
        fixture.detectChanges();
        expect(panel()).not.toBeNull();

        click(trigger);
        fixture.detectChanges();
        expect(panel()).toBeNull();
    });

    it('closes on a click outside but survives a click on its own content', () => {
        const {fixture, trigger, panel, segments} = setup();
        click(trigger);
        fixture.detectChanges();

        click(segments()[1]);
        fixture.detectChanges();
        expect(panel(), 'a click inside must not close it').not.toBeNull();

        click(document.body);
        fixture.detectChanges();
        expect(panel()).toBeNull();
    });

    it('closes on escape', () => {
        const {fixture, trigger, panel} = setup();
        click(trigger);
        fixture.detectChanges();

        document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        fixture.detectChanges();

        expect(panel()).toBeNull();
    });
});

describe('NoiseSuppressionPopoverComponent mode', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('reads the mode from the shared setting', () => {
        const {component} = setup('enhanced');
        expect(component.mode()).toBe('enhanced');
    });

    it('offers all three modes least-processed first, with the current one pressed', () => {
        const {fixture, trigger, segments} = setup('standard');
        click(trigger);
        fixture.detectChanges();

        expect(segments().map(s => s.textContent?.trim())).toEqual([
            'VOICE_BAR.NS_OFF',
            'VOICE_BAR.NS_STANDARD',
            'VOICE_BAR.NS_ENHANCED',
        ]);
        expect(segments().map(s => s.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    });

    it('writes the chosen mode back to the shared setting', () => {
        const {component, fixture, trigger, segments, update} = setup('standard');
        click(trigger);
        fixture.detectChanges();

        click(segments()[2]);
        fixture.detectChanges();

        expect(update).toHaveBeenCalledWith({noiseSuppressionMode: 'enhanced'});
        expect(component.mode()).toBe('enhanced');
        expect(segments().map(s => s.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
    });

    it('describes each mode with its own line', () => {
        for (const mode of ['none', 'standard', 'enhanced'] as const) {
            TestBed.resetTestingModule();
            const {component} = setup(mode);
            const suffix = {none: 'OFF', standard: 'STANDARD', enhanced: 'ENHANCED'}[mode];
            expect(component['hintKey']()).toBe(`VOICE_BAR.NS_${suffix}_HINT`);
        }
    });

    it('tints the trigger only at enhanced', () => {
        for (const mode of ['none', 'standard', 'enhanced'] as const) {
            TestBed.resetTestingModule();
            const {trigger} = setup(mode);
            expect(trigger.className.includes('bg-brand/15'), mode).toBe(mode === 'enhanced');
        }
    });
});

describe('NoiseSuppressionPopoverComponent meter', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('lights bars up to the engine level and no further', () => {
        const {component, fixture, level} = setup();
        level.set(0.5);
        fixture.detectChanges();

        const lit = component['bars'].filter(i => component['barActive'](i));
        expect(lit.length).toBe(12);
    });

    it('lights nothing in silence', () => {
        const {component} = setup();
        expect(component['bars'].some(i => component['barActive'](i))).toBe(false);
    });

    it('runs green through amber to red across the scale', () => {
        const {component} = setup();
        expect(component['barClass'](0)).toContain('emerald');
        expect(component['barClass'](17)).toContain('amber');
        expect(component['barClass'](23)).toContain('rose');
    });
});
