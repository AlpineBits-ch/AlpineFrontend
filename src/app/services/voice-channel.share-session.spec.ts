/**
 * Bug this pins: a screen share is pulled from the wrong Cloudflare session, so the first subscribe
 * to a share fails and stays failed until the streamer changes resolution.
 *
 * <p>A guild screen share does not live on the session its publisher speaks with. The Rust publisher
 * opens its own session and marks it <b>secondary</b> precisely so it is never recorded as the
 * participant's audio - `src-tauri/src/media/publisher/mod.rs` ("the screen share must never be
 * recorded as the participant's audio session") against `src-tauri/src/media/voice/mod.rs`, which
 * opens the microphone's session as primary. Two sessions, two ids, one participant.</p>
 *
 * <p>The server states both. `TrackPublished` carries the session the publish call arrived on, and
 * the snapshot carries `shares[].mediaSessionId` alongside `trackNames` - the frontend guide spells
 * out that it is "**not** necessarily the publisher's microphone session" and its worked example
 * deliberately shows a share on `cf-def` under a participant on `cf-abc`. Our `VoiceShareSnapshot`
 * declared only `{shareId, trackNames}`, so that field was dropped on deserialization and
 * `subscribeFromSnapshot` paired the share's track names with the participant's *microphone*
 * session - the only id it had left.</p>
 *
 * <p>What that costs, in the order the console showed it:</p>
 *
 * <ol>
 *   <li>The subscribe names a track that session does not publish, so the server answers
 *   `409 staleSubscription, refetchSnapshot`.</li>
 *   <li>The refetch returns the same snapshot, which is re-read the same wrong way, so the refusal
 *   and the refetch chase each other.</li>
 *   <li>Worse than failing: on the audio half it *destroys a working subscription*. A viewer who was
 *   present when the share started already pulled it correctly from the live `TrackPublished`, so
 *   the snapshot's mic-session id reads as a corrected announcement -
 *   `[voice] session id changed, resubscribing` unsubscribes the good pull and replaces it with one
 *   that 409s. The tell in the log is that every share id in the room resubscribes *to the same*
 *   session id, because there is only ever one microphone session per publisher.</li>
 * </ol>
 *
 * <p>And it explains the shape the user reported: changing the resolution restarts the publish onto
 * a fresh secondary session and emits a fresh `TrackPublished`, which is the one path that carries
 * the right handle - so the share appears to fix itself, until the next snapshot clobbers it again.</p>
 *
 * <p>These tests assert only which session a share's tracks are pulled from, and stay silent on how
 * the client obtains it - the fix declares the field and skips a share whose session is unknown, but
 * either half could be rewritten without touching what is asserted here.</p>
 *
 * <p><b>Not covered here, same confusion one layer up.</b> The 404s on
 * `POST/DELETE .../voice/shares/{shareId}/watch` in the same console output are a second bug:
 * `guildScreenShares` (`shared/call/call-projection.ts`) builds the watch claim's id as
 * `p.mediaSessionId ?? p.userId`, so the microphone session id goes on the wire where the server
 * expects a share id - it matches `{shareId}` against `ActiveScreenShare.ShareId` and 404s on
 * anything else. It is left out because the guild roster row carries no share id to use instead, so
 * pinning it means changing what that row carries.</p>
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
                    // The roster asks for every id it cannot name - see `channelParticipants`.
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

    type AudioTarget = {mediaSessionId: string; trackName: string};
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
    /**
     * The joiner's case, and the one that fails outright: nobody announced this share to us live, so
     * the snapshot is the only thing that can say where it is - and it does say, in a field we drop.
     */
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

    /**
     * The microphone session must never be the answer for a share track, whatever the snapshot is
     * missing. Asserted separately from the expectations above because it is the half that does the
     * damage: this is the id the console showed every share in the room being resubscribed *to*.
     */
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

    /**
     * The pre-recording shape: `shares[].mediaSessionId` is null on a share the server stored before
     * it kept the handle, and the guide's instruction for it is "use the handle you already have
     * from `TrackPublished`" - not "assume the microphone session".
     *
     * <p>This is the sequence that turns a working stream into a broken one. The live announcement
     * lands first and is correct; the snapshot that follows re-announces the same track names under
     * the participant's session, which `VoiceRTCService.subscribeQueued` reads as a corrected session
     * id and honours by dropping the subscription that was working.</p>
     */
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
