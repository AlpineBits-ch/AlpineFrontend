/**
 * Bug this fixes: joining the same channel from a second device did not kick the first, so both
 * fought over one media session and the first device's audio silently broke. The kick is entirely
 * server-driven; the client's only job is to tear down cleanly when told.
 */
import {TestBed} from '@angular/core/testing';
import {of, Subject} from 'rxjs';
import {loadStickyVoiceState, VoiceChannelService} from './voice-channel.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {GuildVoiceService} from './guild-voice.service';
import {VoiceRTCService} from './voice-rtc.service';
import {ProfileService} from './profile.service';
import {SoundSettingsService} from './sound-settings.service';
import {VoiceEngineService} from './voice-engine.service';
import {ToastService} from './toast.service';
import {ChannelDto, ChannelType} from '../dtos/response/guild.dto';
import {installMemoryStorage} from '../testing/memory-storage';

function setup(options: {inChannel?: boolean} = {}) {
    const ws: Record<string, Subject<unknown>> = {};
    for (const name of [
        'userJoinedVoiceObservable', 'userLeftVoiceObservable', 'guildParticipantJoinedObservable',
        'guildTrackPublishedObservable', 'guildTrackClosedObservable', 'voiceMuteChangedObservable',
        'voiceDeafenChangedObservable', 'voiceCameraChangedObservable',
        'voiceScreenShareStartedObservable', 'voiceScreenShareStoppedObservable',
        'movedToChannelObservable', 'kickedByOtherDeviceObservable',
    ]) ws[name] = new Subject();

    // Outbound calls, as opposed to the subjects above. The service announces its own mute and
    // deafen through these, which is the only way the rest of the room learns about either.
    const wsCalls: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of [
        'invokeVoiceMuteChanged', 'invokeVoiceDeafenChanged', 'invokeVoiceCameraChanged',
        'invokeVoiceScreenShareStarted', 'invokeVoiceScreenShareStopped', 'invokeVoiceHeartbeat',
    ]) wsCalls[name] = vi.fn();

    const guildVoice = {
        join: vi.fn(() => of({participants: []})),
        leave: vi.fn(() => of(undefined)),
        getState: vi.fn(() => of({participants: []})),
    };
    // Every member the service reads at construction: the subjects it subscribes to and the
    // pass-through signals it aliases as its own fields.
    const rtc = {
        closeAllTracks: vi.fn(async () => undefined),
        subscribeAudio: vi.fn(async () => undefined),
        teardown: vi.fn(),
        connect: vi.fn(async () => true),
        setDeafened: vi.fn(),
        setPttOpen: vi.fn(),
        speakingChanges$: new Subject(),
        screenEnded$: new Subject(),
        rtcState: () => 'connected',
        participantsWithAudio: () => new Set(),
        localVideoStream: () => null,
        localScreenStream: () => null,
        localScreenHasAudio: () => false,
        localScreenAudioMuted: () => false,
        videoStreams: () => new Map(),
        screenStreams: () => new Map(),
        screenAudioMuted: () => new Map(),
    };
    const toast = {info: vi.fn(), success: vi.fn(), httpError: vi.fn()};
    const engineSetMute = vi.fn(async () => undefined);

    TestBed.configureTestingModule({
        providers: [
            {provide: GuildWebsocketService, useValue: {...ws, ...wsCalls}},
            {provide: GuildVoiceService, useValue: guildVoice},
            {provide: VoiceRTCService, useValue: rtc},
            {
                provide: ProfileService,
                useValue: {ownProfile: () => ({userId: 'me'}), getCachedByUserId: () => null},
            },
            {
                provide: SoundSettingsService,
                useValue: {playVoiceJoin: vi.fn(), playVoiceLeave: vi.fn()},
            },
            {
                // Both signals are read by effects that run at construction, so an incomplete
                // stub throws before any test body executes.
                provide: VoiceEngineService,
                useValue: {speaking: () => false, remoteLevels: () => new Map(), setMute: engineSetMute},
            },
            {provide: ToastService, useValue: toast},
        ],
    });

    const service = TestBed.inject(VoiceChannelService);
    if (options.inChannel !== false) {
        service.joinedChannelId.set('chan-1');
        service.joinedGuildId.set('guild-1');
    }
    return {service, ws, wsCalls, guildVoice, rtc, toast, engineSetMute};
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));

it('tears down without calling leave - the server already removed us', async () => {
    const {service, ws, guildVoice, rtc, toast} = setup();

    ws['kickedByOtherDeviceObservable'].next({channelId: 'chan-1', guildId: 'guild-1'});
    await tick();

    expect(rtc.teardown).toHaveBeenCalled();
    expect(guildVoice.leave).not.toHaveBeenCalled();
    expect(service.joinedChannelId()).toBeNull();
    expect(service.joinedGuildId()).toBeNull();
    expect(toast.info).toHaveBeenCalledWith('You joined this channel from another device');
});

it('ignores a kick for a channel we are not in', async () => {
    const {service, ws, rtc} = setup();

    ws['kickedByOtherDeviceObservable'].next({channelId: 'other-chan', guildId: 'guild-1'});
    await tick();

    expect(rtc.teardown).not.toHaveBeenCalled();
    expect(service.joinedChannelId()).toBe('chan-1');
});

/**
 * The backend announces us to ourselves, and since audio moved to its own Rust session that
 * announcement carries the session *we* publish on. Cloudflare will not let a session pull its own
 * local track, so subscribing to it fails identically on every retry and logs a participant who was
 * never going to be audible - us.
 */
it('does not subscribe to our own audio when the server announces us', async () => {
    const {ws, rtc} = setup();

    ws['guildParticipantJoinedObservable'].next({
        channelId: 'chan-1', userId: 'me', cfSessionId: 'sess-mine', audioTrackName: 'audio',
    });
    await tick();

    expect(rtc.subscribeAudio).not.toHaveBeenCalled();
});

it('still subscribes when somebody else is announced', async () => {
    const {ws, rtc} = setup();

    ws['guildParticipantJoinedObservable'].next({
        channelId: 'chan-1', userId: 'them', cfSessionId: 'sess-theirs', audioTrackName: 'audio',
    });
    await tick();

    expect(rtc.subscribeAudio).toHaveBeenCalledWith([
        {userId: 'them', cfSessionId: 'sess-theirs', trackName: 'audio'},
    ]);
});

/**
 * Mute and deafen as preferences rather than call state.
 *
 * <p>The change is small - four sites stop resetting two flags - but it is the one place in this
 * feature where a partial application is worse than none. Preserve the flag at join without also
 * seeding the roster entry and announcing it, and the user's microphone is off while every other
 * participant renders them live. So each site gets its own test, and so does the pair that has to
 * travel together.</p>
 */
describe('sticky mute and deafen', () => {
    const CHANNEL = {
        id: 'chan-2',
        guildId: 'guild-1',
        name: 'General',
        type: ChannelType.Voice,
    } as ChannelDto;
    const STORAGE_KEY = 'alpine_voice_local_state';

    // The unit-test environment's localStorage is a stub without `clear`, and every read here is
    // wrapped in a try/catch that would swallow the difference as "nothing stored".
    let restoreStorage: () => void;
    beforeEach(() => restoreStorage = installMemoryStorage());
    afterEach(() => restoreStorage());

    describe('loadStickyVoiceState', () => {
        it('starts un-muted when nothing was stored', () => {
            expect(loadStickyVoiceState()).toEqual({isMuted: false, isDeafened: false});
        });

        it('reads back what was stored', () => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({isMuted: true, isDeafened: true}));
            expect(loadStickyVoiceState()).toEqual({isMuted: true, isDeafened: true});
        });

        /** A corrupt blob must read as "not muted", not as whatever a stray value coerces to. */
        it('treats anything that is not exactly true as false', () => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({isMuted: 'yes', isDeafened: 1}));
            expect(loadStickyVoiceState()).toEqual({isMuted: false, isDeafened: false});
        });

        it('survives unparseable storage', () => {
            localStorage.setItem(STORAGE_KEY, 'not json');
            expect(loadStickyVoiceState()).toEqual({isMuted: false, isDeafened: false});
        });

        /** Neither can mean anything after a channel change - both hold a live publication. */
        it('never restores camera or screen share', () => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(
                {isMuted: true, isDeafened: false, isCameraOn: true, isScreenSharing: true}));
            expect(loadStickyVoiceState()).toEqual({isMuted: true, isDeafened: false});
        });
    });

    it('restores mute from storage on construction', () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({isMuted: true, isDeafened: false}));

        const {service} = setup({inChannel: false});

        expect(service.localState().isMuted).toBe(true);
    });

    it('keeps mute across a join', async () => {
        const {service} = setup({inChannel: false});
        service.toggleMute();

        await service.joinChannel(CHANNEL, 'Guild');

        expect(service.localState().isMuted).toBe(true);
    });

    it('keeps mute across a leave', async () => {
        const {service} = setup({inChannel: false});
        service.toggleMute();
        await service.joinChannel(CHANNEL, 'Guild');

        await service.leaveChannel();

        expect(service.localState().isMuted).toBe(true);
    });

    it('keeps mute when another device takes the channel over', async () => {
        const {service, ws} = setup();
        service.toggleMute();

        ws['kickedByOtherDeviceObservable'].next({channelId: 'chan-1', guildId: 'guild-1'});
        await tick();

        expect(service.localState().isMuted).toBe(true);
    });

    it('still clears camera and screen share on join', async () => {
        const {service} = setup({inChannel: false});

        await service.joinChannel(CHANNEL, 'Guild');

        expect(service.localState().isCameraOn).toBe(false);
        expect(service.localState().isScreenSharing).toBe(false);
    });

    it('seeds its own roster entry from the sticky state', async () => {
        const {service} = setup({inChannel: false});
        service.toggleMute();

        await service.joinChannel(CHANNEL, 'Guild');

        const own = service.channelParticipants().get(CHANNEL.id)?.find(p => p.isLocal);
        expect(own?.isMuted).toBe(true);
    });

    /** The join event carries no mute state, so everyone else would render the user live. */
    it('tells the room it arrived muted', async () => {
        const {service, wsCalls} = setup({inChannel: false});
        service.toggleMute();
        wsCalls['invokeVoiceMuteChanged'].mockClear();

        await service.joinChannel(CHANNEL, 'Guild');

        expect(wsCalls['invokeVoiceMuteChanged']).toHaveBeenCalledWith(CHANNEL.id, true);
    });

    it('says nothing about mute when it arrived un-muted', async () => {
        const {service, wsCalls} = setup({inChannel: false});

        await service.joinChannel(CHANNEL, 'Guild');

        expect(wsCalls['invokeVoiceMuteChanged']).not.toHaveBeenCalled();
    });

    it('tells the room, and the mixer, that it arrived deafened', async () => {
        const {service, wsCalls, rtc} = setup({inChannel: false});
        service.toggleDeafen();
        rtc.setDeafened.mockClear();

        await service.joinChannel(CHANNEL, 'Guild');

        expect(wsCalls['invokeVoiceDeafenChanged']).toHaveBeenCalledWith(CHANNEL.id, true);
        // Without this the user hears everyone despite the button saying otherwise - syncMic only
        // gates the outgoing microphone.
        expect(rtc.setDeafened).toHaveBeenCalledWith(true);
    });

    it('applies mute to the engine as soon as it is toggled, call or no call', () => {
        const {service, engineSetMute} = setup({inChannel: false});

        service.toggleMute();

        expect(engineSetMute).toHaveBeenCalledWith(true);
    });

    it('writes mute through to storage', () => {
        const {service} = setup({inChannel: false});

        service.toggleMute();

        expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'))
            .toEqual({isMuted: true, isDeafened: false});
    });

    /** Deafening implies muting, and both halves have to survive a restart. */
    it('writes deafen through to storage together with the mute it forces', () => {
        const {service} = setup({inChannel: false});

        service.toggleDeafen();

        expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'))
            .toEqual({isMuted: true, isDeafened: true});
    });
});

