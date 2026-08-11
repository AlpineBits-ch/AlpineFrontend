/**
 * The settings vocabulary, and the delegate's own bookkeeping.
 *
 * <p>The processing payload is deserialised by field name in Rust, so a rename or a unit mismatch here
 * is a setting that silently stops working rather than an error anyone sees. These cover the two volume
 * sliders in particular: both are stored 0-100 and consumed as 0.0-1.0 gains, and until this was wired
 * they moved, saved, and changed nothing.</p>
 *
 * <p>No `vi.mock('@tauri-apps/api/core')` any more. This service no longer touches the IPC module at
 * all - it delegates to the {@link VoicePublisher} port - so {@link FakeVoicePublisher} is provided in
 * TestBed instead. That is the shape the design spec asks every one of these specs to move to, and it is
 * strictly better here: the old mock forced `isTauri()` true to stop the service short-circuiting, which
 * meant these assertions only held on one host.</p>
 */
import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {FakeVoicePublisher, idleVoiceStats} from '../platform/testing/fake-voice-publisher';
import {VoiceProcessing, VoicePublisher, VoiceSession, VoiceTarget} from '../platform/ports/voice-publisher.port';
import {AudioSettings, AudioSettingsService} from './audio-settings.service';
import {SILENCE_DBFS, VoiceEngineService} from './voice-engine.service';

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

let engine: VoiceEngineService;
let publisher: FakeVoicePublisher;

/** The most recent payload to reach the port. */
function lastPayload(): VoiceProcessing {
    expect(publisher.processing, 'no settings reached the publisher').not.toBeNull();
    return publisher.processing!;
}

const GUILD: VoiceTarget = {kind: 'guild', guildId: 'g1', channelId: 'c1'};

async function start(target: VoiceTarget = GUILD): Promise<VoiceSession> {
    return await engine.start(target, 'https://api.example.test', 'tok', 'dev-1');
}

beforeEach(() => {
    withSettings({});
    publisher = new FakeVoicePublisher();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            {provide: AudioSettingsService, useValue: {settings}},
            {provide: VoicePublisher, useValue: publisher},
        ],
    });
    engine = TestBed.inject(VoiceEngineService);
});

describe('the settings payload', () => {
    it('sends both volume sliders as gains, not percentages', async () => {
        withSettings({inputVolume: 40, outputVolume: 25});

        await engine.applySettings();

        expect(lastPayload().inputVolume).toBe(0.4);
        expect(lastPayload().outputVolume).toBe(0.25);
    });

    it('keeps the two sliders on their own fields', async () => {
        // One scales what is sent and the other what is heard. Crossing them over would be invisible
        // until someone set them to different values.
        withSettings({inputVolume: 20, outputVolume: 80});

        await engine.applySettings();

        expect(lastPayload().inputVolume).toBe(0.2);
        expect(lastPayload().outputVolume).toBe(0.8);
    });

    it('falls back to full volume rather than muting on a broken value', async () => {
        // A corrupted or absent stored setting arriving as NaN would multiply a whole frame to NaN,
        // silencing either the microphone or every remote participant until the next rejoin.
        withSettings({inputVolume: NaN, outputVolume: undefined as unknown as number});

        await engine.applySettings();

        expect(lastPayload().inputVolume).toBe(1);
        expect(lastPayload().outputVolume).toBe(1);
    });

    it('clamps a slider that somehow exceeds its range', async () => {
        withSettings({inputVolume: 400, outputVolume: -50});

        await engine.applySettings();

        expect(lastPayload().inputVolume).toBe(1);
        expect(lastPayload().outputVolume).toBe(0);
    });

    /**
     * The cutoff slider and the engine's sensitivity run in opposite directions, and the inversion
     * happens exactly once, here. Getting it backwards is silent in both directions: the setting saves,
     * the payload sends, the gate applies it - and every user's microphone behaves as though their
     * slider were mirrored.
     */
    it('sends the cutoff slider to the engine as its inverse', async () => {
        withSettings({voiceThreshold: 0});
        await engine.applySettings();
        expect(lastPayload().sensitivity).toBe(1);

        withSettings({voiceThreshold: 100});
        await engine.applySettings();
        expect(lastPayload().sensitivity).toBe(0);
    });

    it('puts the shipped default in the permissive half of the range', async () => {
        // A default that gates an ordinary talker is the reported bug, and nobody changes a default
        // they have not been bitten by - so it has to err open.
        const {DEFAULTS} = await import('./audio-settings.service');

        withSettings({voiceThreshold: DEFAULTS.voiceThreshold});
        await engine.applySettings();

        expect(lastPayload().sensitivity).toBeGreaterThan(0.5);
    });

    it('does not let a corrupted cutoff mute the microphone', async () => {
        // A missing or NaN stored value must not arrive as "only transmit a shout". Sensitivity 1.0 is
        // the gate switched off, which is the safe end to fail towards.
        withSettings({voiceThreshold: NaN});
        await engine.applySettings();
        expect(lastPayload().sensitivity).toBe(1);
    });

    it('maps the input mode to the engine\'s two names', async () => {
        withSettings({inputMode: 'push-to-talk'});
        await engine.applySettings();
        expect(lastPayload().inputMode).toBe('ptt');

        withSettings({inputMode: 'voice-activity'});
        await engine.applySettings();
        expect(lastPayload().inputMode).toBe('voice');
    });

    it('sends a default device as null rather than the word "default"', async () => {
        // Null means "the host default" on both adapters; the literal string is a device name that
        // matches nothing, which on desktop is a capture that opens nothing at all.
        withSettings({micId: 'default', speakerId: 'default'});
        await engine.applySettings();
        expect(lastPayload().deviceId).toBeNull();
        expect(lastPayload().outputDeviceId).toBeNull();

        withSettings({micId: 'Headset', speakerId: 'Speakers'});
        await engine.applySettings();
        expect(lastPayload().deviceId).toBe('Headset');
        expect(lastPayload().outputDeviceId).toBe('Speakers');
    });
});

describe('starting a call', () => {
    it('pushes the settings itself, immediately before the start', async () => {
        // The port's `start` carries no settings, and both adapters need them by then: one opens its
        // capture devices with them, the other its `getUserMedia` constraints.
        //
        // Asserted as an *order*, and with the log cleared first, because the settings effect pushes the
        // identical payload on its own schedule - so "a push carrying the current settings arrived" is
        // true whether or not `start` does it, and a test shaped that way passes against a start that
        // carries nothing. Mutated by deleting the push: the log reads `['start']`.
        withSettings({inputVolume: 50});
        TestBed.flushEffects();
        publisher.calls.length = 0;

        await start();

        expect(publisher.calls.map(call => call[0])).toEqual(['setProcessing', 'start']);
        expect((publisher.callsTo('setProcessing')[0][0] as VoiceProcessing).inputVolume).toBe(0.5);
    });

    it('pushes a settings change at the adapter as it happens', async () => {
        // Without this the audio settings page would appear to work and change nothing until the next
        // rejoin - and the input-mode switch in particular would be silently dead, because the gate
        // that reads it lives below this service.
        await start();
        publisher.calls.length = 0;

        withSettings({inputVolume: 10});
        TestBed.flushEffects();

        expect((publisher.callsTo('setProcessing').at(-1)![0] as VoiceProcessing).inputVolume).toBe(0.1);
    });

    it('passes the target and the credentials through untouched', async () => {
        await start();
        const options = publisher.startOptions[0];
        expect(options.target).toEqual(GUILD);
        expect(options.apiBase).toBe('https://api.example.test');
        expect(options.token).toBe('tok');
        expect(options.deviceId).toBe('dev-1');
    });

    it('is active for as long as any call is running', async () => {
        expect(engine.active()).toBe(false);
        const guild = await start();
        const isle = await start({kind: 'isle'});
        expect(engine.active()).toBe(true);

        await engine.stop(guild);
        // Isle survives leaving a guild channel - it is a separate publication on the same microphone.
        expect(engine.active()).toBe(true);

        await engine.stop(isle);
        expect(engine.active()).toBe(false);
    });

    it('ends every publication on stopAll, naming each one', async () => {
        // The slotless `voice_stop` has no equivalent on the port, so this has to name them - which is
        // why the delegate holds the sessions rather than only their slot names. Mutated by holding
        // slots alone: there is nothing to hand `stop`.
        const guild = await start();
        const isle = await start({kind: 'isle'});

        await engine.stopAll();

        expect(publisher.stopped.sort()).toEqual([guild.slot, isle.slot].sort());
        expect(engine.active()).toBe(false);
    });
});

describe('the engine events', () => {
    it('drive the local meter and the speaking indicator', async () => {
        const session = await start();
        publisher.emit(session, {speaking: true, level: 0.4, levelDb: -12, thresholdDb: -45});

        expect(engine.speaking()).toBe(true);
        expect(engine.level()).toBe(0.4);
        expect(engine.levelDb()).toBe(-12);
        expect(engine.thresholdDb()).toBe(-45);
    });

    it('drive every remote participant\'s meter', async () => {
        // The only remote speaking signal there is: playout happens below this line on both hosts, so
        // there are no elements left for the webview to analyse for itself.
        const session = await start();
        publisher.emit(session, {kind: 'levels', levels: [{id: 'user_a', level: 0.3, speaking: true}]});

        expect(engine.remoteLevels().get('user_a')?.speaking).toBe(true);
    });

    it('clear a slot\'s meters when its call ends', async () => {
        const session = await start();
        await engine.subscribe(session, 'user_a', 'their_sess', 'audio');
        publisher.emit(session, {kind: 'levels', levels: [{id: 'user_a', level: 0.3, speaking: true}]});
        publisher.emit(session, {speaking: true, level: 0.4});

        await engine.stop(session);

        expect(engine.remoteLevels().has('user_a')).toBe(false);
        expect(engine.speaking()).toBe(false);
        expect(engine.levelDb()).toBe(SILENCE_DBFS);
    });

    it('report an error without disturbing the meters', async () => {
        const session = await start();
        publisher.emit(session, {speaking: true, level: 0.4});
        publisher.emit(session, {kind: 'error', message: 'device lost'});

        expect(engine.speaking()).toBe(true);
    });
});

describe('the hardware controls', () => {
    it('reach the port without a session, because there is only one microphone', async () => {
        await engine.setMute(true);
        await engine.setDeafened(true);
        await engine.setUserVolume('user_a', 0.25);

        expect(publisher.muted).toBe(true);
        expect(publisher.deafened).toBe(true);
        expect(publisher.userVolumes.get('user_a')).toBe(0.25);
    });

    it('carry a position inside the argument, with the id the caller passed', async () => {
        // The spec's `setPosition` takes one argument and no participant id, which cannot address the
        // per-source table - so the id travels inside it while the caller's signature stays as it was.
        await engine.setPosition('user_a', {x: 1, y: 2, z: 3});
        await engine.setPosition('user_a', null);

        expect(publisher.callsTo('setPosition')).toEqual([
            [{id: 'user_a', position: {x: 1, y: 2, z: 3}}],
            [{id: 'user_a', position: null}],
        ]);
    });

    it('forward the spatial model as the mixer takes it', async () => {
        const model = {refDistance: 2, rolloff: 1.6, maxDistance: 40, intensity: 0.8};
        await engine.setSpatialModel(model);
        expect(publisher.spatialModel).toEqual(model);
    });

    it('key one call without keying the other', async () => {
        // Proximity push-to-talk must not also open the guild channel's microphone. The port is what
        // keeps them apart, and this is the delegate not collapsing them on the way through.
        const guild = await start();
        const isle = await start({kind: 'isle'});

        await engine.setPttOpen(isle, true);

        expect(publisher.pttOpen.get(isle.slot)).toBe(true);
        expect(publisher.pttOpen.get(guild.slot)).toBeUndefined();
    });
});

describe('stats', () => {
    it('hand back what the adapter reports, including an idle engine', async () => {
        // No longer null outside Tauri: an adapter with nothing running answers zeroed counters and
        // `running: false`, which is a fact a caller can render rather than one it has to special-case.
        publisher.statsSnapshot = idleVoiceStats();
        expect((await engine.stats())?.running).toBe(false);

        publisher.statsSnapshot = idleVoiceStats({running: true, packetsEncoded: 42});
        expect((await engine.stats())?.packetsEncoded).toBe(42);
    });
});

describe('availability', () => {
    it('is true on both hosts now that a browser has a real publisher', () => {
        // This used to be `isTauri()`. A caller that skipped voice on the strength of it would now be
        // skipping a working feature.
        expect(engine.available()).toBe(true);
    });
});
