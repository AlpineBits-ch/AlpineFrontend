/**
 * The settings payload is deserialised by field name in Rust, so a rename or a unit mismatch here
 * is a setting that silently stops working rather than an error anyone sees.
 *
 * These cover the two volume sliders in particular: both are stored 0-100 and consumed as 0.0-1.0
 * gains, and until this was wired they moved, saved, and changed nothing.
 */
// `isTauri` is a spy rather than a fixed arrow, and is set below per test.
//
// This file used to fail intermittently, and the diagnosis written here originally - that several
// spec files mock this module and only one registration wins per run - had the mechanism exactly
// right and the conclusion wrong. It was not unavoidable. The cause was
// `@angular/build:unit-test` defaulting Vitest to `isolate: false`, which gives every spec file in
// a worker one shared module registry; which file's `vi.mock` won then depended on how Vitest
// batched files across workers, which depends on core count. That is why it read as load
// sensitivity - CPU pressure changes the batching, not the timing. There is not one timer in this
// file, and "passes when run alone" meant "no other file in the batch to clobber the mock".
//
// `vitest-base.config.ts` now sets `isolate: true`, so this mock is the only one in play here. The
// per-test `isTauri` reset below is kept regardless: it costs nothing and it states what the
// engine has to believe for these assertions to mean anything.
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn().mockResolvedValue(undefined),
    isTauri: vi.fn(() => true),
    Channel: class {
    },
}));

import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {invoke, isTauri} from '@tauri-apps/api/core';
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
        voiceThreshold: 50,
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
    // After clearAllMocks, which would otherwise drop it. These tests are about what reaches Rust,
    // so the engine has to believe it is running under Tauri whichever mock registration won.
    vi.mocked(isTauri).mockReturnValue(true);
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

/**
 * The cutoff slider and the engine's sensitivity run in opposite directions, and the inversion
 * happens exactly once, here. Getting it backwards is silent in both directions: the setting saves,
 * the payload sends, the gate applies it - and every user's microphone behaves as though their
 * slider were mirrored. Which is the failure this whole change exists for, arriving from the other
 * side.
 */
it('sends the cutoff slider to the engine as its inverse', async () => {
    withSettings({voiceThreshold: 0});
    await engine.applySettings();
    expect(lastPayload()['sensitivity']).toBe(1);

    withSettings({voiceThreshold: 100});
    await engine.applySettings();
    expect(lastPayload()['sensitivity']).toBe(0);
});

it('puts the shipped default in the permissive half of the range', async () => {
    // A default that gates an ordinary talker is the reported bug, and nobody changes a default
    // they have not been bitten by - so it has to err open.
    const {DEFAULTS} = await import('./audio-settings.service');

    withSettings({voiceThreshold: DEFAULTS.voiceThreshold});
    await engine.applySettings();

    expect(lastPayload()['sensitivity']).toBeGreaterThan(0.5);
});

it('does not let a corrupted cutoff mute the microphone', async () => {
    // A missing or NaN stored value must not arrive as "only transmit a shout". Sensitivity 1.0 is
    // the gate switched off, which is the safe end to fail towards.
    withSettings({voiceThreshold: NaN});
    await engine.applySettings();
    expect(lastPayload()['sensitivity']).toBe(1);
});
