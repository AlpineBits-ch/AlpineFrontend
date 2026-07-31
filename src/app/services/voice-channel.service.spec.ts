/**
 * Bug this fixes: joining the same channel from a second device did not kick the first, so both
 * fought over one media session and the first device's audio silently broke. The kick is entirely
 * server-driven; the client's only job is to tear down cleanly when told.
 */
import {TestBed} from '@angular/core/testing';
import {of, Subject} from 'rxjs';
import {VoiceChannelService} from './voice-channel.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {GuildVoiceService} from './guild-voice.service';
import {VoiceRTCService} from './voice-rtc.service';
import {ProfileService} from './profile.service';
import {SoundSettingsService} from './sound-settings.service';
import {VoiceEngineService} from './voice-engine.service';
import {ToastService} from './toast.service';

function setup() {
    const ws: Record<string, Subject<unknown>> = {};
    for (const name of [
        'userJoinedVoiceObservable', 'userLeftVoiceObservable', 'guildParticipantJoinedObservable',
        'guildTrackPublishedObservable', 'guildTrackClosedObservable', 'voiceMuteChangedObservable',
        'voiceDeafenChangedObservable', 'voiceCameraChangedObservable',
        'voiceScreenShareStartedObservable', 'voiceScreenShareStoppedObservable',
        'movedToChannelObservable', 'kickedByOtherDeviceObservable',
    ]) ws[name] = new Subject();

    const guildVoice = {
        leave: vi.fn(() => of(undefined)),
        getState: vi.fn(() => of({participants: []})),
    };
    // Every member the service reads at construction: the subjects it subscribes to and the
    // pass-through signals it aliases as its own fields.
    const rtc = {
        closeAllTracks: vi.fn(async () => undefined),
        teardown: vi.fn(),
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

    TestBed.configureTestingModule({
        providers: [
            {provide: GuildWebsocketService, useValue: ws},
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
                useValue: {speaking: () => false, remoteLevels: () => new Map()},
            },
            {provide: ToastService, useValue: toast},
        ],
    });

    const service = TestBed.inject(VoiceChannelService);
    service.joinedChannelId.set('chan-1');
    service.joinedGuildId.set('guild-1');
    return {service, ws, guildVoice, rtc, toast};
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
