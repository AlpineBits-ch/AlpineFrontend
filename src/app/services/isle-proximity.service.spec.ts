/**
 * The orchestrator's half of the proximity subscribe path: an order must never be discarded here.
 *
 * <p>`isVoiceActive` is set at the *end* of join - after the publish and after the hotkeys are armed -
 * while the relay pushes `isle.SubscribeMutual` for every already-audible peer from inside the publish
 * itself. Gating the forward on it therefore threw away exactly the orders that matter most: the ones
 * for people who were already standing there when you joined. Since the same order establishes both the
 * audio track and the positional entity, and the relay will not repeat it while the pair stays audible,
 * each order lost was a peer left silent and unplaced for the whole session.</p>
 *
 * <p>Deciding whether an order can be acted on yet is `IsleVoiceRtcService`'s job, because it is the only
 * thing that knows whether a publication exists - so this asserts the forward is unconditional.</p>
 */
import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {of, Subject} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {IsleProximityService} from './isle-proximity.service';
import {IsleVoiceApiService} from './isle-voice-api.service';
import {
    IslePeerLeft,
    IslePlayerDisconnected,
    IslePlayerJoined,
    IslePlayerPosition,
    IsleSelfPosition,
    IsleSubscribeMutual,
    IsleVoiceWebsocketService,
} from './isle-voice-websocket.service';
import {IsleVoiceRtcService} from './isle-voice-rtc.service';
import {SpatialAudioService} from './spatial-audio.service';
import {HotkeyService} from './hotkey.service';
import {NativePttService} from './native-ptt.service';
import {AudioSettings, AudioSettingsService} from './audio-settings.service';
import {KeybindsService} from './keybinds.service';
import {UserService} from './user.service';
import {ToastService} from './toast.service';
import {SoundSettingsService} from './sound-settings.service';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';
import {PrivacySettingsService} from './privacy-settings.service';

function setup() {
    const ws = {
        start: vi.fn(async () => void 0),
        playerJoined$: new Subject<IslePlayerJoined>(),
        playerDisconnected$: new Subject<IslePlayerDisconnected>(),
        subscribeMutual$: new Subject<IsleSubscribeMutual>(),
        selfPosition$: new Subject<IsleSelfPosition>(),
        playerPosition$: new Subject<IslePlayerPosition>(),
        peerLeft$: new Subject<IslePeerLeft>(),
        republishVoice$: new Subject<void>(),
    };
    const rtc = {
        subscribeToPeer: vi.fn(async (_userId: string, _peerSessionId: string, _trackName: string) => void 0),
        tearDownPeer: vi.fn(),
        tearDownAllRemotePeers: vi.fn(),
        setMicEnabled: vi.fn(),
        setMicGain: vi.fn(),
        connect: vi.fn(async () => true),
        disconnect: vi.fn(async () => void 0),
        reconcile: vi.fn(async () => void 0),
        peers: signal<Set<string>>(new Set()),
        rtcState: signal<RTCPeerConnectionState>('new'),
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            {provide: IsleVoiceWebsocketService, useValue: ws},
            {provide: IsleVoiceRtcService, useValue: rtc},
            {
                provide: IsleVoiceApiService,
                useValue: {
                    join: () => of(undefined),
                    leave: () => of(undefined),
                    getStatus: () => of({isGameConnected: true, isVoiceConnected: false}),
                },
            },
            {
                provide: SpatialAudioService,
                useValue: {
                    updateSelf: vi.fn(),
                    updatePeer: vi.fn(),
                    setMasterVolume: vi.fn(),
                    setSpatialEnabled: vi.fn(),
                    setOutputDevice: vi.fn(async () => void 0),
                },
            },
            {provide: HotkeyService, useValue: {supported: false, bind: vi.fn(), unbind: vi.fn(async () => void 0)}},
            {
                provide: NativePttService,
                useValue: {
                    supported: () => false,
                    whenReady: async () => void 0,
                    edgesFor: () => new Subject<boolean>(),
                    setBinding: vi.fn(),
                    arm: vi.fn(),
                    disarm: vi.fn(),
                },
            },
            {provide: AudioSettingsService, useValue: {settings: signal({} as AudioSettings), update: vi.fn()}},
            {provide: KeybindsService, useValue: {rebind$: new Subject<string>(), getBinding: () => null}},
            {provide: UserService, useValue: {self: signal({steamId: 'steam-1'})}},
            {provide: ToastService, useValue: {error: vi.fn(), httpError: vi.fn()}},
            {provide: SoundSettingsService, useValue: {playVoiceLeave: vi.fn()}},
            {provide: RealtimeConnectionService, useValue: {connectionState: signal(ConnectionState.Connected)}},
            {provide: PrivacySettingsService, useValue: {allowPositionalVoiceCapture: () => true}},
        ],
    });

    const service = TestBed.inject(IsleProximityService);
    // Detection - and therefore the signalling wiring - starts from an effect on the loaded user.
    TestBed.flushEffects();
    return {service, ws, rtc};
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('isle.SubscribeMutual', () => {
    it('is forwarded even before the join has finished', () => {
        const {service, ws, rtc} = setup();
        expect(service.isVoiceActive(), 'the window this test is about is the one before this flips').toBe(false);

        ws.subscribeMutual$.next({targetUserId: 'u1', cfSessionId: 'peer-session-1', trackName: 'audio'});

        expect(rtc.subscribeToPeer).toHaveBeenCalledWith('u1', 'peer-session-1', 'audio');
    });

    it('is forwarded for every peer in a burst', () => {
        // A join into a populated cell produces one of these per peer already in the block, all in the
        // same window. They are what the join-time silence was made of.
        const {ws, rtc} = setup();

        for (const id of ['u1', 'u2', 'u3']) {
            ws.subscribeMutual$.next({targetUserId: id, cfSessionId: `s-${id}`, trackName: 'audio'});
        }

        expect(rtc.subscribeToPeer.mock.calls.map(call => call[0])).toEqual(['u1', 'u2', 'u3']);
    });
});

describe('the status poll', () => {
    it('re-drives the subscribe reconcile while connected', async () => {
        // The only route back for a peer whose pull exhausted its retries: the relay records the pair
        // as pushed whatever we made of it, so it will not order us again while they stay audible.
        const {service, rtc} = setup();
        await service.join();
        expect(service.isVoiceActive(), 'join did not complete, so this proves nothing').toBe(true);
        rtc.reconcile.mockClear();

        await vi.advanceTimersByTimeAsync(60_000);

        expect(rtc.reconcile).toHaveBeenCalled();
    });

    it('does not reconcile when proximity voice is not running', async () => {
        const {rtc} = setup();

        await vi.advanceTimersByTimeAsync(60_000);

        expect(rtc.reconcile).not.toHaveBeenCalled();
    });
});
