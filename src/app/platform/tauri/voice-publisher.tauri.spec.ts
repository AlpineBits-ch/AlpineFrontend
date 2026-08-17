/**
 * The desktop adapter's payloads, field for field.
 *
 * <p>Every `voice_*` argument is deserialised into a Rust struct <b>by name</b>, so a renamed or
 * dropped field is a command that silently stops working rather than an error anyone sees. That is why
 * these assertions are on the argument objects rather than on "the command was called": a spec that
 * checked only the command name would pass against an adapter that sent an empty body.</p>
 *
 * <p>These are also the byte-for-byte record of what `VoiceEngineService` used to send inline. If this
 * file and `src-tauri/src/media/voice/mod.rs` disagree, the adapter is wrong.</p>
 */
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn().mockResolvedValue(undefined),
    isTauri: vi.fn(() => true),
    Channel: class {
        onmessage: ((event: unknown) => void) | null = null;
    },
}));

import {invoke} from '@tauri-apps/api/core';
import {TauriVoicePublisher} from './voice-publisher.tauri';
import type {VoiceProcessing, VoicePublisherEvent, VoiceSession} from '../ports/voice-publisher.port';

const SESSION: VoiceSession = {slot: 'primary', mediaSessionId: 'sess', trackName: 'audio'};

const processing = (patch: Partial<VoiceProcessing> = {}): VoiceProcessing => ({
    deviceId: null,
    outputDeviceId: null,
    noiseSuppression: 'standard',
    echoCancellation: true,
    autoGainControl: true,
    inputMode: 'voice',
    sensitivity: 0.6,
    inputVolume: 1,
    outputVolume: 1,
    bitrateBps: null,
    ...patch,
});

let publisher: TauriVoicePublisher;

/** The argument object of the most recent call to `command`. */
function payloadOf(command: string): Record<string, unknown> {
    const calls = vi.mocked(invoke).mock.calls.filter(c => c[0] === command);
    expect(calls.length, `${command} was never invoked`).toBeGreaterThan(0);
    return calls.at(-1)![1] as Record<string, unknown>;
}

function callsTo(command: string): number {
    return vi.mocked(invoke).mock.calls.filter(c => c[0] === command).length;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue(undefined);
    publisher = new TauriVoicePublisher();
});

/**
 * A publication on `slot`, so the commands that need one have one.
 *
 * The settings push is what the delegate does immediately before every start, and it is not optional
 * here: without it the adapter has nothing to open the devices with.
 */
async function started(settings: VoiceProcessing = processing(), slot = 'primary'): Promise<VoiceSession> {
    vi.mocked(invoke).mockResolvedValueOnce({slot, mediaSessionId: 'sess', trackName: 'audio'});
    await publisher.setProcessing(settings);
    return await publisher.start({
        target: {kind: 'guild', guildId: 'g1', channelId: 'c1'},
        apiBase: 'https://api.example.test',
        token: 'tok',
        deviceId: 'dev-1',
    });
}

describe('start', () => {
    it('carries the target, the credentials and the settings the engine opens its devices with', async () => {
        await started();

        const payload = payloadOf('voice_start');
        expect(payload['guildId']).toBe('g1');
        expect(payload['channelId']).toBe('c1');
        expect(payload['callId']).toBeNull();
        expect(payload['isle']).toBe(false);
        expect(payload['apiBase']).toBe('https://api.example.test');
        expect(payload['token']).toBe('tok');
        expect(payload['deviceId']).toBe('dev-1');
        expect(payload['settings']).toEqual(processing());
    });

    it('passes no ICE servers', async () => {
        // Deliberate. The SFU is publicly routable and answers to whatever source address it sees;
        // passing STUN servers bought nothing and added the one step in gathering that can block on
        // the network - which wedged the whole negotiation queue behind it.
        await started();
        expect(payloadOf('voice_start')['iceServers']).toEqual([]);
    });

    it('identifies a DM call by its id and Isle by the absence of one', async () => {
        // Isle addresses no channel or call, so it is flagged rather than identified - and Rust reads
        // the flag only after both id pairs have failed to match.
        vi.mocked(invoke).mockResolvedValue({slot: 'primary', mediaSessionId: 's', trackName: 'audio'});
        await publisher.start({
            target: {kind: 'call', callId: 'call-1'},
            apiBase: 'b',
            token: 't',
            deviceId: 'd',
        });
        expect(payloadOf('voice_start')['callId']).toBe('call-1');
        expect(payloadOf('voice_start')['isle']).toBe(false);

        vi.mocked(invoke).mockResolvedValue({slot: 'isle', mediaSessionId: 's', trackName: 'audio'});
        await publisher.start({target: {kind: 'isle'}, apiBase: 'b', token: 't', deviceId: 'd'});
        expect(payloadOf('voice_start')['isle']).toBe(true);
        expect(payloadOf('voice_start')['guildId']).toBeNull();
        expect(payloadOf('voice_start')['callId']).toBeNull();
    });

    it('subscribes the caller to the engine event channel', async () => {
        // Without this every meter in the app is dead: the speaking indicator, the input level, and
        // every remote participant's level come through here and nowhere else.
        const events: VoicePublisherEvent[] = [];
        vi.mocked(invoke).mockResolvedValueOnce({slot: 'primary', mediaSessionId: 's', trackName: 'audio'});
        await publisher.start({
            target: {kind: 'isle'},
            apiBase: 'b',
            token: 't',
            deviceId: 'd',
            onEvent: e => events.push(e),
        });

        const channel = payloadOf('voice_start')['onEvent'] as {onmessage: (e: unknown) => void};
        channel.onmessage({kind: 'speaking', speaking: true, level: 0.4, levelDb: -8, thresholdDb: -50});
        expect(events).toHaveLength(1);
        expect(events[0].speaking).toBe(true);
    });
});

describe('the settings push', () => {
    it('does not reach a stopped engine', async () => {
        // `voice_set_processing` no-ops in Rust when no engine exists, so sending it while idle would
        // be harmless - but it would also be the only thing in the log, which is worse than nothing.
        await publisher.setProcessing(processing());
        expect(callsTo('voice_set_processing')).toBe(0);
    });

    it('reaches a running engine', async () => {
        await started();
        await publisher.setProcessing(processing({inputVolume: 0.5}));

        expect(callsTo('voice_set_processing')).toBe(1);
        expect(payloadOf('voice_set_processing')['settings']).toEqual(processing({inputVolume: 0.5}));
    });

    it('is not repeated when nothing changed', async () => {
        // `Engine::set_config` reopens or closes *every* publication according to the gate mode, so a
        // redundant push while a guild call is up would reset that call's push-to-talk state. The
        // delegate pushes settings before every start, which makes joining Isle mid-call exactly this
        // case. Mutated by dropping the dedupe: this reads 2.
        await started();
        await publisher.setProcessing(processing());
        await publisher.setProcessing(processing());
        expect(callsTo('voice_set_processing')).toBe(0);
    });

    it('carries the settings pushed while nothing was running into the start', async () => {
        // The push while idle sends no command - the assertion above - so this is the only path by
        // which the user's chosen microphone reaches the engine at all.
        await started(processing({deviceId: 'Headset', sensitivity: 0.2}));
        expect(payloadOf('voice_start')['settings']).toEqual(
            processing({deviceId: 'Headset', sensitivity: 0.2}),
        );
    });
});

describe('the per-call commands', () => {
    it('names the slot on stop, subscribe, unsubscribe and ptt', async () => {
        // Every one of these addresses one publication. Sending the wrong slot - or none - would key
        // or tear down the other call, which is the whole hazard slots exist to remove.
        await publisher.stop(SESSION);
        expect(payloadOf('voice_stop')).toEqual({slot: 'primary'});

        await publisher.subscribe(SESSION, 'user_a', 'their_sess', 'audio');
        expect(payloadOf('voice_subscribe')).toEqual({
            slot: 'primary',
            id: 'user_a',
            mediaSessionId: 'their_sess',
            trackName: 'audio',
        });

        await publisher.unsubscribe(SESSION, 'user_a');
        expect(payloadOf('voice_unsubscribe')).toEqual({slot: 'primary', id: 'user_a'});

        await publisher.setPttOpen(SESSION, true);
        expect(payloadOf('voice_set_ptt_open')).toEqual({slot: 'primary', open: true});
    });

    it('rejects a failed subscribe rather than resolving quietly', async () => {
        // Nothing retries below this line, so a swallowed error is a participant who stays silent for
        // the rest of the session.
        vi.mocked(invoke).mockRejectedValueOnce('staleSubscription: 409');
        await expect(publisher.subscribe(SESSION, 'user_a', 'sess', 'audio')).rejects.toBeTruthy();
    });
});

describe('the hardware commands', () => {
    it('take no slot, because there is only one microphone', async () => {
        await publisher.setMute(true);
        expect(payloadOf('voice_set_mute')).toEqual({muted: true});

        await publisher.setDeafened(true);
        expect(payloadOf('voice_set_deafened')).toEqual({deafened: true});

        await publisher.setUserVolume('user_a', 0.25);
        // `id`, not `userId`: the command's parameter is named `id` in Rust and the port's is not.
        expect(payloadOf('voice_set_user_volume')).toEqual({id: 'user_a', volume: 0.25});
    });
});

describe('the spatial commands', () => {
    it('flattens the model into the four scalars the command takes', async () => {
        await publisher.setSpatialModel({refDistance: 2, rolloff: 1.6, maxDistance: 40, intensity: 0.8});
        expect(payloadOf('voice_set_spatial_model')).toEqual({
            refDistance: 2,
            rolloff: 1.6,
            maxDistance: 40,
            intensity: 0.8,
        });
    });

    it('sends a position as three coordinates, and an un-place as three nulls', async () => {
        // Rust reads the triple: any missing coordinate un-places the source rather than defaulting to
        // zero, so a partially-sent position cannot put someone at the listener's feet.
        await publisher.setPosition({id: 'user_a', position: {x: 1, y: 2, z: 3}});
        expect(payloadOf('voice_set_position')).toEqual({id: 'user_a', x: 1, y: 2, z: 3});

        await publisher.setPosition({id: 'user_a', position: null});
        expect(payloadOf('voice_set_position')).toEqual({id: 'user_a', x: null, y: null, z: null});
    });
});

describe('stats', () => {
    it('hands back what the engine reports, including an idle engine', async () => {
        // `voice_stats` already answers `running: false` with zeroed counters, which is what lets the
        // port type this non-nullable - a caller never has to tell "no engine" from "engine idle".
        vi.mocked(invoke).mockResolvedValueOnce({running: false, sources: [], publications: []});
        const stats = await publisher.stats();
        expect(stats.running).toBe(false);
    });
});

describe('vad support', () => {
    it('is off, because the desktop host has a real global hotkey', () => {
        // Not "the engine cannot gate on speech" - it has had a voice-activity gate all along. This
        // flag is about VAD standing in for a key that cannot be delivered, and here it can.
        expect(publisher.supportsVad).toBe(false);
    });
});
