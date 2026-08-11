/**
 * The settings vocabulary, and the delegate's own bookkeeping.
 *
 * <p>The processing payload is deserialised by field name in Rust, so a rename or a unit mismatch here
 * is a setting that silently stops working rather than an error anyone sees. These cover the two volume
 * sliders in particular: both are stored 0-100 and consumed as 0.0-1.0 gains, and until this was wired
 * they moved, saved, and changed nothing.</p>
 *
 * <p>No `vi.mock('@tauri-apps/api/core')` any more. This service no longer touches the IPC module at
 * all - it delegates to the {@link VoicePublisher} port - so the fake below is provided in TestBed
 * instead. That is the shape the design spec asks every one of these specs to move to, and it is
 * strictly better here: the old mock forced `isTauri()` true to stop the service short-circuiting, which
 * meant these assertions only held on one host.</p>
 */
import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {
    Position,
    SpatialModel,
    VoiceProcessing,
    VoicePublisher,
    VoicePublisherEvent,
    VoiceSession,
    VoiceStartOptions,
    VoiceStats,
} from '../platform/ports/voice-publisher.port';
import {AudioSettings, AudioSettingsService} from './audio-settings.service';
import {SILENCE_DBFS, VoiceEngineService} from './voice-engine.service';

/**
 * Stands in for either adapter, and records what reached the port.
 *
 * <p>Faithful about one thing that matters: `start` hands back the slot the target maps onto, because
 * the delegate's slot bookkeeping is what {@link VoiceEngineService.stopAll} and the `active` signal
 * are built on.</p>
 */
class FakePublisher extends VoicePublisher {
    readonly supportsVad = false;

    readonly processing: VoiceProcessing[] = [];
    readonly started: VoiceStartOptions[] = [];
    readonly stopped: VoiceSession[] = [];
    readonly positions: Position[] = [];
    readonly models: SpatialModel[] = [];
    readonly volumes: [string, number][] = [];
    readonly ptt: [VoiceSession, boolean][] = [];
    muted: boolean | null = null;
    deafened: boolean | null = null;
    /** The callback the service registered, so a test can drive the engine's events through it. */
    onEvent: ((event: VoicePublisherEvent) => void) | undefined;

    /**
     * The settings this adapter was holding when `start` was called.
     *
     * <p>Recorded because "were the settings pushed first" cannot be answered from the call list: the
     * service's own settings effect pushes the same payload of its own accord, so a test that merely
     * looks for a push finds one either way and passes against a `start` that carries nothing. What
     * distinguishes them is <b>which</b> payload was in the adapter's hands at that moment.</p>
     */
    processingAtStart: VoiceProcessing | null = null;

    readonly subscribe = vi.fn().mockResolvedValue(undefined);
    readonly unsubscribe = vi.fn().mockResolvedValue(undefined);

    async start(o: VoiceStartOptions): Promise<VoiceSession> {
        this.started.push(o);
        this.processingAtStart = this.processing.at(-1) ?? null;
        this.onEvent = o.onEvent;
        const slot = o.target.kind === 'isle' ? 'isle' : 'primary';
        return {slot, mediaSessionId: `sess-${slot}`, trackName: 'audio'};
    }

    async stop(s: VoiceSession): Promise<void> {
        this.stopped.push(s);
    }

    async setPttOpen(s: VoiceSession, open: boolean): Promise<void> {
        this.ptt.push([s, open]);
    }

    async setMute(muted: boolean): Promise<void> {
        this.muted = muted;
    }

    async setDeafened(deafened: boolean): Promise<void> {
        this.deafened = deafened;
    }

    async setUserVolume(userId: string, volume: number): Promise<void> {
        this.volumes.push([userId, volume]);
    }

    async setProcessing(p: VoiceProcessing): Promise<void> {
        this.processing.push(p);
    }

    async setSpatialModel(m: SpatialModel): Promise<void> {
        this.models.push(m);
    }

    async setPosition(p: Position): Promise<void> {
        this.positions.push(p);
    }

    async stats(): Promise<VoiceStats> {
        return {
            running: false, framesCaptured: 0, captureRms: 0, packetsEncoded: 0, muted: false,
            gateOpen: false, playoutFrames: 0, mixRms: 0, deafened: false, masterVolume: 1,
            sources: [], publications: [],
        };
    }
}

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
let publisher: FakePublisher;

/** The most recent payload to reach the port. */
function lastPayload(): VoiceProcessing {
    expect(publisher.processing.length, 'no settings reached the publisher').toBeGreaterThan(0);
    return publisher.processing.at(-1)!;
}

const GUILD = {kind: 'guild', guildId: 'g1', channelId: 'c1'} as const;

async function start(target: VoiceStartOptions['target'] = GUILD): Promise<VoiceSession> {
    return await engine.start(target, 'https://api.example.test', 'tok', 'dev-1');
}

beforeEach(() => {
    withSettings({});
    publisher = new FakePublisher();
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
    it('pushes the settings itself, rather than relying on the settings effect having run', async () => {
        // The port's `start` carries no settings, and both adapters need them by then: one opens its
        // capture devices with them, the other its `getUserMedia` constraints.
        //
        // The record is cleared once the effect has settled, so the start's own push is the only thing
        // that can put anything back. Without that clear the assertion would be satisfied by the
        // settings effect, which pushes the identical payload of its own accord - and the point here is
        // that `start` does not depend on the effect having run. Mutated by deleting the push: both
        // assertions below fail.
        withSettings({inputVolume: 50});
        TestBed.flushEffects();
        publisher.processing.length = 0;

        await start();

        expect(publisher.processing).toHaveLength(1);
        expect(publisher.processingAtStart?.inputVolume).toBe(0.5);
        expect(publisher.started).toHaveLength(1);
    });

    it('pushes a settings change at the adapter as it happens', async () => {
        // Without this the audio settings page would appear to work and change nothing until the next
        // rejoin - and the input-mode switch in particular would be silently dead, because the gate
        // that reads it lives below this service.
        await start();
        publisher.processing.length = 0;

        withSettings({inputVolume: 10});
        TestBed.flushEffects();

        expect(publisher.processing.at(-1)?.inputVolume).toBe(0.1);
    });

    it('passes the target and the credentials through untouched', async () => {
        await start();
        const options = publisher.started[0];
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
        await start();
        await start({kind: 'isle'});

        await engine.stopAll();

        expect(publisher.stopped.map(s => s.slot).sort()).toEqual(['isle', 'primary']);
        expect(engine.active()).toBe(false);
    });
});

describe('the engine events', () => {
    it('drive the local meter and the speaking indicator', async () => {
        await start();
        publisher.onEvent!({kind: 'speaking', speaking: true, level: 0.4, levelDb: -12, thresholdDb: -45});

        expect(engine.speaking()).toBe(true);
        expect(engine.level()).toBe(0.4);
        expect(engine.levelDb()).toBe(-12);
        expect(engine.thresholdDb()).toBe(-45);
    });

    it('drive every remote participant\'s meter', async () => {
        // The only remote speaking signal there is: playout happens below this line on both hosts, so
        // there are no elements left for the webview to analyse for itself.
        await start();
        publisher.onEvent!({
            kind: 'levels', speaking: false, level: 0, levelDb: 0, thresholdDb: 0,
            levels: [{id: 'user_a', level: 0.3, speaking: true}],
        });

        expect(engine.remoteLevels().get('user_a')?.speaking).toBe(true);
    });

    it('clear a slot\'s meters when its call ends', async () => {
        await start();
        await engine.subscribe(
            {slot: 'primary', mediaSessionId: 'sess-primary', trackName: 'audio'},
            'user_a', 'their_sess', 'audio');
        publisher.onEvent!({
            kind: 'levels', speaking: false, level: 0, levelDb: 0, thresholdDb: 0,
            levels: [{id: 'user_a', level: 0.3, speaking: true}],
        });

        await engine.stop({slot: 'primary', mediaSessionId: 'sess-primary', trackName: 'audio'});

        expect(engine.remoteLevels().has('user_a')).toBe(false);
        expect(engine.speaking()).toBe(false);
        expect(engine.levelDb()).toBe(SILENCE_DBFS);
    });

    it('report an error without disturbing the meters', async () => {
        await start();
        publisher.onEvent!({kind: 'speaking', speaking: true, level: 0.4, levelDb: -12, thresholdDb: -45});
        publisher.onEvent!({
            kind: 'error', speaking: false, level: 0, levelDb: 0, thresholdDb: 0, message: 'device lost',
        });

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
        expect(publisher.volumes).toEqual([['user_a', 0.25]]);
    });

    it('carry a position inside the argument, with the id the caller passed', async () => {
        // The spec's `setPosition` takes one argument and no participant id, which cannot address the
        // per-source table - so the id travels inside it while the caller's signature stays as it was.
        await engine.setPosition('user_a', {x: 1, y: 2, z: 3});
        await engine.setPosition('user_a', null);

        expect(publisher.positions).toEqual([
            {id: 'user_a', position: {x: 1, y: 2, z: 3}},
            {id: 'user_a', position: null},
        ]);
    });
});

describe('availability', () => {
    it('is true on both hosts now that a browser has a real publisher', () => {
        // This used to be `isTauri()`. A caller that skipped voice on the strength of it would now be
        // skipping a working feature.
        expect(engine.available()).toBe(true);
    });
});
