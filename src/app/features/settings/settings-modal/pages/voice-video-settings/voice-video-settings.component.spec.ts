/** The four host gates on the voice page, each asserted on both hosts. */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {describe, expect, it} from 'vitest';
import {VoiceVideoSettingsComponent} from './voice-video-settings.component';
import {AudioSettings, AudioSettingsService} from '../../../../../services/audio-settings.service';
import {DeviceOption, MediaDeviceCatalogService} from '../../../../../services/media-device-catalog.service';
import {IsleProximityService} from '../../../../../services/isle-proximity.service';
import {VoiceEngineService} from '../../../../../services/voice-engine.service';
import {VoiceActivityService} from '../../../../../services/voice-activity.service';
import {OutputSupport} from '../../../../../platform/media-device-support';
import {provideFakePlatform} from '../../../../../platform/testing/provide-fake-platform';
import {PlatformHost} from '../../../../../platform/host';

interface Options {
    inputMode?: AudioSettings['inputMode'];
    outputSupport?: OutputSupport;
    namesWithheld?: boolean;
    speakers?: DeviceOption[];
}

function render(host: PlatformHost, options: Options = {}): ComponentFixture<VoiceVideoSettingsComponent> {
    const settings = signal({
        micId: 'default',
        speakerId: 'default',
        cameraId: '',
        noiseSuppressionMode: 'standard',
        echoCancellation: true,
        autoGainControl: true,
        inputMode: options.inputMode ?? 'voice-activity',
        voiceThreshold: 40,
        vadStrength: 0.6,
        inputVolume: 100,
        outputVolume: 100,
        proximityVolume: 1,
        proximityMicGain: 1,
        proximitySpatialEnabled: true,
    } as unknown as AudioSettings);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideTranslateService(),
            provideFakePlatform({host}),
            // Stubbed rather than real: the real service persists through `localStorage` from a field
            // initialiser, and none of that decides which controls this page renders.
            {
                provide: AudioSettingsService,
                useValue: {
                    settings,
                    update: (patch: Partial<AudioSettings>) =>
                        settings.update(s => ({...s, ...patch})),
                    buildAudioConstraint: async () => true,
                    buildVideoConstraint: async () => true,
                    resolveSpeakerSinkId: async () => null,
                },
            },
            // The catalog is what separates "no speakers" from "this browser will not say", so the two
            // facts are injected directly rather than inferred from a device list.
            {
                provide: MediaDeviceCatalogService,
                useValue: {
                    mics: signal<DeviceOption[]>([{label: 'Built-in mic', value: 'mic-1'}]),
                    speakers: signal<DeviceOption[]>(options.speakers ?? []),
                    namesWithheld: signal(options.namesWithheld ?? false),
                    outputSupport: signal<OutputSupport>(
                        options.outputSupport ?? {enumerable: true, selectable: true}),
                    refresh: async () => undefined,
                },
            },
            {
                provide: VoiceEngineService,
                useValue: {
                    active: signal(false),
                    levelDb: signal(-100),
                    thresholdDb: signal(-100),
                },
            },
            {
                provide: IsleProximityService,
                useValue: {
                    setVolume: () => undefined,
                    setMicGain: () => undefined,
                    setSpatialEnabled: () => undefined,
                },
            },
        ],
    });

    const fixture = TestBed.createComponent(VoiceVideoSettingsComponent);
    fixture.detectChanges();
    return fixture;
}

function byTestId(fixture: ComponentFixture<VoiceVideoSettingsComponent>, id: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-testid="${id}"]`);
}

/** The push-to-talk radio, which is the second one in the Input Mode group. */
function pttRadio(fixture: ComponentFixture<VoiceVideoSettingsComponent>): HTMLInputElement {
    const radios = fixture.nativeElement.querySelectorAll('p-radiobutton input');
    return radios[1] as HTMLInputElement;
}

describe('VoiceVideoSettingsComponent push to talk', () => {
    it('is selectable on the desktop shell, and offers the keybinds link when chosen', () => {
        const fixture = render('tauri', {inputMode: 'push-to-talk'});

        expect(pttRadio(fixture).disabled).toBe(false);
        expect(byTestId(fixture, 'ptt-unsupported')).toBeNull();
        expect(fixture.nativeElement.textContent).toContain('Push-to-Talk Key');
    });

    it('is disabled with a stated reason in a browser', () => {
        const fixture = render('web');

        expect(pttRadio(fixture).disabled).toBe(true);
        expect(byTestId(fixture, 'ptt-unsupported')?.textContent?.trim())
            .toBe('SETTINGS.VOICE.PTT_UNSUPPORTED');
    });

    it('does not offer a key to bind in a browser, even with the mode stored', () => {
        // The stored mode survives a move from the desktop app. Offering "Open Keybinds" here would
        // send the user to bind a key that cannot fire while the game has focus.
        const fixture = render('web', {inputMode: 'push-to-talk'});

        expect(fixture.nativeElement.textContent).not.toContain('Push-to-Talk Key');
    });
});

describe('VoiceVideoSettingsComponent voice activity controls', () => {
    it('are absent on the desktop shell, which draws its own gate meter instead', () => {
        const fixture = render('tauri');

        expect(byTestId(fixture, 'vad-sensitivity')).toBeNull();
        // The desktop card is still there - this gate must not have taken both meters away.
        expect(fixture.nativeElement.textContent).toContain('Input Sensitivity');
    });

    it('offer a sensitivity slider and a live meter in a browser', () => {
        const fixture = render('web');
        const card = byTestId(fixture, 'vad-sensitivity');

        expect(card).not.toBeNull();
        expect(card?.querySelector('p-slider')).not.toBeNull();
        expect(card?.textContent).toContain('SETTINGS.VOICE.VAD_SENSITIVITY_DESC');
    });

    it('show up even when the stored mode is push-to-talk', () => {
        // The gate runs on speech in a browser whatever the stored mode says, so hiding the threshold
        // here would leave that user with no way to be heard and no control to reach for.
        expect(byTestId(render('web', {inputMode: 'push-to-talk'}), 'vad-sensitivity')).not.toBeNull();
    });

    it('put the cutoff handle where the gate actually opens', () => {
        const fixture = render('web');
        const vad = TestBed.inject(VoiceActivityService);
        const component = fixture.componentInstance;

        // Two thresholds an order of magnitude apart must move the handle, and the stricter one must
        // move it right. A handle that ignored the gate's own threshold would sit still through this.
        vad.setThreshold(0.002);
        const permissive = component.vadCutoffPercent();
        vad.setThreshold(0.2);
        const strict = component.vadCutoffPercent();

        expect(strict).toBeGreaterThan(permissive);
        expect(permissive).toBeGreaterThan(0);
        expect(strict).toBeLessThan(100);
    });

    it('say the bar is idle until something feeds the gate', () => {
        expect(byTestId(render('web'), 'vad-idle')).not.toBeNull();
    });
});

describe('VoiceVideoSettingsComponent output device', () => {
    it('is offered where playback can be routed, even with no speakers enumerated', () => {
        // The case the old gate would have got wrong in the other direction: the list is empty and the
        // picker still means something, because the "Default" entry routes to the system default.
        const fixture = render('web', {outputSupport: {enumerable: true, selectable: true}});

        expect(byTestId(fixture, 'output-picker')).not.toBeNull();
        expect(byTestId(fixture, 'output-not-selectable')).toBeNull();
    });

    it('is replaced by a reason where the host will not route playback', () => {
        const fixture = render('web', {outputSupport: {enumerable: false, selectable: false}});

        expect(byTestId(fixture, 'output-picker')).toBeNull();
        expect(byTestId(fixture, 'output-not-selectable')?.textContent?.trim())
            .toBe('SETTINGS.VOICE.OUTPUT_NOT_SELECTABLE');
    });

    it('is offered on the desktop shell, which always reports full support', () => {
        expect(byTestId(render('tauri'), 'output-picker')).not.toBeNull();
    });
});

describe('VoiceVideoSettingsComponent withheld device names', () => {
    it('says nothing while the names are real', () => {
        expect(byTestId(render('web'), 'device-names-withheld')).toBeNull();
        expect(byTestId(render('tauri'), 'device-names-withheld')).toBeNull();
    });

    it('explains the numbered stand-ins when the host is withholding them', () => {
        const fixture = render('web', {namesWithheld: true});

        expect(byTestId(fixture, 'device-names-withheld')?.textContent?.trim())
            .toBe('SETTINGS.VOICE.DEVICE_NAMES_WITHHELD');
    });
});

describe('VoiceVideoSettingsComponent Isle proximity voice', () => {
    it('points at the keybinds page on the desktop shell', () => {
        const fixture = render('tauri');

        expect(byTestId(fixture, 'isle-keybinds-link')).not.toBeNull();
        expect(byTestId(fixture, 'isle-hotkey-unsupported')).toBeNull();
    });

    it('replaces it with the reason and the substitute in a browser', () => {
        const fixture = render('web');

        expect(byTestId(fixture, 'isle-keybinds-link')).toBeNull();
        expect(byTestId(fixture, 'isle-hotkey-unsupported')?.textContent?.trim())
            .toBe('SETTINGS.VOICE.ISLE_HOTKEY_UNSUPPORTED');
    });
});
