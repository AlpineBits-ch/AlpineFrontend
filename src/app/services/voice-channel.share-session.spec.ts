/**
 * A screen share is published on its own secondary session, never the publisher's microphone one:
 * pull its tracks from `shares[].mediaSessionId`, and skip the share when that is unknown.
 *
 * Getting it wrong is silent both ways: the subscribe 409s in a refetch loop, and on the audio half
 * it reads as a corrected session id and tears down a subscription that was working.
 */
import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {TranslateService} from '@ngx-translate/core';
import {of, Subject} from 'rxjs';
import {VoiceChannelService} from './voice-channel.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {ConnectionState} from './realtime-connection.service';
import {GuildVoiceService} from './guild-voice.service';
import {VoiceRTCService} from './voice-rtc.service';
import {ProfileService} from './profile.service';
import {SoundSettingsService} from './sound-settings.service';
import {VoiceEngineService} from './voice-engine.service';
import {ToastService} from './toast.service';
import {EntitlementStore} from '../stores/entitlement.store';
import {installMemoryStorage} from '../testing/memory-storage';
import {VoiceParticipantSnapshot, VoiceRoomSnapshot, VoiceShareSnapshot} from '../models/voice-room';

/** The session the streamer's microphone is on. Exactly one per participant, hence the name. */
const MIC_SESSION = 'cf-mic-them';
/** The session the Rust publisher opened for the share. A new one per publish. */
const SHARE_SESSION = 'cf-screen-them';

function emptySnapshot(roomId: string): VoiceRoomSnapshot {
    return {
        roomId, kind: 'channel', guildId: 'guild-1',
        instanceId: 'inst-1', version: 1, participants: [],
    };
}

/** A streamer: publishing a microphone on {@link MIC_SESSION}, sharing from wherever `over` says. */
function streamer(
    shares: VoiceShareSnapshot[],
    over: Partial<VoiceParticipantSnapshot> = {},
): VoiceParticipantSnapshot {
    return {
        userId: 'them',
        mediaSessionId: MIC_SESSION,
        audioTrackName: 'audio',
        publishState: 'Publishing',
        isSelfMuted: false, isSelfDeafened: false,
        isServerMuted: false, isServerDeafened: false,
        isStreaming: true,
        shares,
        joinedAt: '2026-08-07T12:00:00Z',
        ...over,
    };
}

function setup() {
    const ws: Record<string, Subject<unknown>> = {};
    for (const name of [
        'userJoinedVoiceObservable', 'userLeftVoiceObservable', 'guildParticipantJoinedObservable',
        'guildTrackPublishedObservable', 'guildTrackClosedObservable', 'voiceMuteChangedObservable',
        'voiceDeafenChangedObservable', 'voiceCameraChangedObservable',
        'voiceScreenShareStartedObservable', 'voiceScreenShareStoppedObservable',
        'movedToChannelObservable', 'kickedByOtherDeviceObservable',
        'voiceSnapshotObservable', 'voiceResyncObservable',
    ]) ws[name] = new Subject();

    const wsCalls: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of [
        'invokeVoiceMuteChanged', 'invokeVoiceDeafenChanged', 'invokeVoiceCameraChanged',
        'invokeVoiceScreenShareStarted', 'invokeVoiceScreenShareStopped', 'invokeVoiceHeartbeat',
    ]) wsCalls[name] = vi.fn();

    const guildVoice = {
        join: vi.fn((_g: string, channelId: string) => of(emptySnapshot(channelId))),
        leave: vi.fn(() => of(undefined)),
        getSnapshot: vi.fn((_g: string, channelId: string) => of(emptySnapshot(channelId))),
    };
    const rtc = {
        closeAllTracks: vi.fn(async () => undefined),
        subscribeAudio: vi.fn(async () => undefined),
        subscribeVideo: vi.fn(async () => undefined),
        subscribedUserIds: vi.fn(() => [] as string[]),
        cleanupParticipant: vi.fn(),
        handleRemoteTrackClosed: vi.fn(),
        publishedMedia: null as {mediaSessionId: string; audioTrackName: string} | null,
        teardown: vi.fn(),
        connect: vi.fn(async () => true),
        setDeafened: vi.fn(),
        setPttOpen: vi.fn(),
        speakingChanges$: new Subject(),
        screenEnded$: new Subject(),
        staleSubscription$: new Subject(),
        rtcState: () => 'connected',
        participantsWithAudio: () => new Set(),
        localVideoStream: () => null,
        localScreenStream: () => null,
        localScreenHasAudio: () => false,
        localScreenAudioMuted: () => false,
        videoStreams: () => new Map(),
        screenStreams: () => new Map(),
        screenAudioMuted: () => new Map(),
        setScreenPreset: vi.fn(async () => null),
        publishCamera: vi.fn(async () => 'video' as string | null),
        closeCamera: vi.fn(async () => undefined),
        publishScreen: vi.fn(async () => ({shareId: 'share-1'}) as {shareId: string} | null),
        closeScreen: vi.fn(async () => ({shareId: 'share-1'}) as {shareId: string} | null),
    };

    TestBed.configureTestingModule({
        providers: [
            {
                provide: GuildWebsocketService,
                useValue: {...ws, ...wsCalls, connectionState: signal(ConnectionState.Connected)},
            },
            {provide: GuildVoiceService, useValue: guildVoice},
            {provide: VoiceRTCService, useValue: rtc},
            {
                provide: ProfileService,
                useValue: {
                    ownProfile: () => ({userId: 'me'}),
                    getCachedByUserId: () => null,
                    // The roster asks for every id it cannot name; see `channelParticipants`.
                    resolveByUserId: vi.fn(),
                },
            },
            {
                provide: SoundSettingsService,
                useValue: {playVoiceJoin: vi.fn(), playVoiceLeave: vi.fn()},
            },
            {
                provide: VoiceEngineService,
                useValue: {
                    speaking: () => false,
                    remoteLevels: () => new Map(),
                    setMute: vi.fn(async () => undefined),
                },
            },
            {provide: ToastService, useValue: {info: vi.fn(), success: vi.fn(), error: vi.fn(), httpError: vi.fn()}},
            {provide: TranslateService, useValue: {instant: (key: string) => key}},
            {provide: EntitlementStore, useValue: {ladder: () => undefined, ensureLoaded: () => void 0}},
        ],
    });

    const service = TestBed.inject(VoiceChannelService);
    service.joinedChannelId.set('chan-1');
    service.joinedGuildId.set('guild-1');
    return {service, ws, rtc};
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));

/** Every session id a share track was offered to the RTC layer under, video and audio alike. */
function sessionsPulledFrom(rtc: ReturnType<typeof setup>['rtc']): string[] {
    // The stubs are declared without argument types, so their recorded calls are read positionally:
    // subscribeVideo(guildId, channelId, userId, mediaSessionId, trackName, kind).
    const videoCalls = rtc.subscribeVideo.mock.calls as unknown as string[][];
    const fromVideo = videoCalls
        .filter(call => call[4]?.startsWith('screen-'))
        .map(call => call[3]);

    interface AudioTarget {mediaSessionId: string; trackName: string}
    const audioCalls = rtc.subscribeAudio.mock.calls as unknown as AudioTarget[][][];
    const fromAudio = audioCalls
        .flatMap(call => call[0] ?? [])
        .filter(t => t.trackName.startsWith('screen-'))
        .map(t => t.mediaSessionId);

    return [...fromVideo, ...fromAudio];
}

let restoreStorage: () => void;
beforeEach(() => restoreStorage = installMemoryStorage());
afterEach(() => restoreStorage());

describe('which session a screen share is pulled from', () => {
    /** The joiner's case: nobody announced this share live, so the snapshot is the only thing that can say where it is. */
    it('pulls a share from the session the snapshot says it is published on', async () => {
        const {ws, rtc} = setup();

        ws['voiceSnapshotObservable'].next({
            ...emptySnapshot('chan-1'),
            participants: [streamer([{
                shareId: 'abc',
                trackNames: ['screen-abc', 'screen-audio-abc'],
                mediaSessionId: SHARE_SESSION,
            }])],
        });
        await tick();

        expect(rtc.subscribeVideo).toHaveBeenCalledWith(
            'guild-1', 'chan-1', 'them', SHARE_SESSION, 'screen-abc', 'screen');
        expect(rtc.subscribeAudio).toHaveBeenCalledWith([
            {userId: 'them', mediaSessionId: SHARE_SESSION, trackName: 'screen-audio-abc', kind: 'screenAudio'},
        ]);
    });

    /** The microphone session must never be the answer for a share track, whatever the snapshot is missing. */
    it('never pulls a share from the publisher\'s microphone session', async () => {
        const {ws, rtc} = setup();

        ws['voiceSnapshotObservable'].next({
            ...emptySnapshot('chan-1'),
            participants: [streamer([{
                shareId: 'abc',
                trackNames: ['screen-abc', 'screen-audio-abc'],
                mediaSessionId: SHARE_SESSION,
            }])],
        });
        await tick();

        expect(sessionsPulledFrom(rtc)).not.toContain(MIC_SESSION);
    });

    /** A null `shares[].mediaSessionId` means keep the handle `TrackPublished` already gave us, never assume the microphone session. */
    it('does not re-point a live share subscription at the microphone session', async () => {
        const {ws, rtc} = setup();

        // Announced live, carrying the session the publish actually happened on.
        ws['guildTrackPublishedObservable'].next({
            channelId: 'chan-1', userId: 'them', mediaSessionId: SHARE_SESSION,
            trackName: 'screen-abc', kind: 'screen', shareId: 'abc',
        });
        ws['guildTrackPublishedObservable'].next({
            channelId: 'chan-1', userId: 'them', mediaSessionId: SHARE_SESSION,
            trackName: 'screen-audio-abc', kind: 'screenAudio', shareId: 'abc',
        });
        await tick();

        ws['voiceSnapshotObservable'].next({
            ...emptySnapshot('chan-1'),
            participants: [streamer([{
                shareId: 'abc',
                trackNames: ['screen-abc', 'screen-audio-abc'],
                mediaSessionId: null,
            }])],
        });
        await tick();

        expect(sessionsPulledFrom(rtc)).not.toContain(MIC_SESSION);
    });
});
