import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal, WritableSignal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {NoiseSuppressionPopoverComponent} from './noise-suppression-popover.component';
import {AudioSettings, AudioSettingsService, DEFAULTS} from '../../../../services/audio-settings.service';
import {VoiceEngineService} from '../../../../services/voice-engine.service';

type Mode = AudioSettings['noiseSuppressionMode'];

function setup(mode: Mode = 'standard'): {
    fixture: ComponentFixture<NoiseSuppressionPopoverComponent>;
    component: NoiseSuppressionPopoverComponent;
    update: ReturnType<typeof vi.fn>;
    level: WritableSignal<number>;
} {
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

    return {fixture, component: fixture.componentInstance, update, level};
}

describe('NoiseSuppressionPopoverComponent mode', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('reads the mode from the shared setting', () => {
        const {component} = setup('enhanced');
        expect(component.mode()).toBe('enhanced');
    });

    it('writes the chosen mode back to the shared setting', () => {
        const {component, update} = setup('standard');
        component['select']('enhanced');

        expect(update).toHaveBeenCalledWith({noiseSuppressionMode: 'enhanced'});
        expect(component.mode()).toBe('enhanced');
    });

    it('offers all three modes least-processed first', () => {
        const {component} = setup();
        expect(component['modes'].map(m => m.value)).toEqual(['none', 'standard', 'enhanced']);
    });

    it('describes each mode with its own line', () => {
        for (const mode of ['none', 'standard', 'enhanced'] as const) {
            TestBed.resetTestingModule();
            const {component} = setup(mode);
            expect(component['hintKey']()).toBe(
                `VOICE_BAR.NS_${{none: 'OFF', standard: 'STANDARD', enhanced: 'ENHANCED'}[mode]}_HINT`,
            );
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
