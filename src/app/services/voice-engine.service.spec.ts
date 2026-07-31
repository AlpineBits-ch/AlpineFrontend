/**
 * The settings payload is deserialised by field name in Rust, so a rename or a unit mismatch here
 * is a setting that silently stops working rather than an error anyone sees.
 *
 * These cover the two volume sliders in particular: both are stored 0-100 and consumed as 0.0-1.0
 * gains, and until this was wired they moved, saved, and changed nothing.
 */
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn().mockResolvedValue(undefined),
    isTauri: () => true,
    Channel: class {
    },
}));

import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {invoke} from '@tauri-apps/api/core';
import {AudioSettings, AudioSettingsService} from './audio-settings.service';
import {VoiceEngineService} from './voice-engine.service';

const settings = signal<AudioSettings>({} as AudioSettings);

/** The fields the payload actually reads; the rest of AudioSettings is irrelevant here. */
function withSettings(overrides: Partial<AudioSettings>): void {
    settings.set({
        micId: 'default',
        speakerId: 'default',
        noiseSuppressionMode: 'standard',
        echoCancellation: true,
        autoGainControl: true,
        inputMode: 'voice-activity',
        inputSensitivity: 50,
        inputVolume: 100,
        outputVolume: 100,
        ...overrides,
    } as AudioSettings);
}

/** The payload of the most recent voice_set_processing call. */
function lastPayload(): Record<string, unknown> {
    const calls = vi.mocked(invoke).mock.calls.filter(c => c[0] === 'voice_set_processing');
    return (calls.at(-1)![1] as {settings: Record<string, unknown>}).settings;
}

let engine: VoiceEngineService;

beforeEach(() => {
    vi.clearAllMocks();
    withSettings({});
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [{provide: AudioSettingsService, useValue: {settings}}],
    });
    engine = TestBed.inject(VoiceEngineService);
});

it('sends both volume sliders as gains, not percentages', async () => {
    withSettings({inputVolume: 40, outputVolume: 25});

    await engine.applySettings();

    const payload = lastPayload();
    expect(payload['inputVolume']).toBe(0.4);
    expect(payload['outputVolume']).toBe(0.25);
});

it('keeps the two sliders on their own fields', async () => {
    // One scales what is sent and the other what is heard. Crossing them over would be invisible
    // until someone set them to different values.
    withSettings({inputVolume: 20, outputVolume: 80});

    await engine.applySettings();

    const payload = lastPayload();
    expect(payload['inputVolume']).toBe(0.2);
    expect(payload['outputVolume']).toBe(0.8);
});

it('falls back to full volume rather than muting on a broken value', async () => {
    // A corrupted or absent stored setting arriving as NaN would multiply a whole frame to NaN in
    // Rust, silencing either the microphone or every remote participant until the next rejoin.
    withSettings({inputVolume: NaN, outputVolume: undefined as unknown as number});

    await engine.applySettings();

    const payload = lastPayload();
    expect(payload['inputVolume']).toBe(1);
    expect(payload['outputVolume']).toBe(1);
});

it('clamps a slider that somehow exceeds its range', async () => {
    withSettings({inputVolume: 400, outputVolume: -50});

    await engine.applySettings();

    const payload = lastPayload();
    expect(payload['inputVolume']).toBe(1);
    expect(payload['outputVolume']).toBe(0);
});
