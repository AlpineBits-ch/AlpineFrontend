import {ApplicationRef, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {TestBed} from '@angular/core/testing';
import {TranslateService} from '@ngx-translate/core';
import {of, Subject, throwError} from 'rxjs';
import {loadStickyVoiceState, VoiceChannelService} from './voice-channel.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {FakeRealtimeConnection} from '../testing/fake-realtime-connection';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';
import {GuildVoiceService} from './guild-voice.service';
import {VoiceRTCService} from './voice-rtc.service';
import {ProfileService} from './profile.service';
import {SoundSettingsService} from './sound-settings.service';
import {VoiceEngineService} from './voice-engine.service';
import {ToastService} from './toast.service';
import {ChannelDto, ChannelType} from '../dtos/response/guild.dto';
import {EntitlementStore} from '../stores/entitlement.store';
import {installMemoryStorage} from '../testing/memory-storage';
import {VoiceParticipantSnapshot, VoiceRoomSnapshot} from '../models/voice-room';
import {SCREEN_RESUME_GRACE_MS} from '../shared/call/screen-resume';

/** A room at v1 with nobody in it: what most of these tests want the recovery path to return. */
function emptySnapshot(roomId: string): VoiceRoomSnapshot {
    return {
        roomId,
        kind: 'channel',
        guildId: 'guild-1',
        instanceId: 'inst-1',
        version: 1,
        participants: [],
    };
}

function publisher(userId: string, over: Partial<VoiceParticipantSnapshot> = {}): VoiceParticipantSnapshot {
    return {
        userId,
        mediaSessionId: `cf-${userId}`,
        audioTrackName: 'audio',
        publishState: 'Publishing',
        isSelfMuted: false,
        isSelfDeafened: false,
        isServerMuted: false,
        isServerDeafened: false,
        isStreaming: false,
        shares: [],
        joinedAt: '2026-08-07T12:00:00Z',
        ...over,
    };
}

function setup(options: {inChannel?: boolean} = {}) {
    const ws = new FakeRealtimeConnection();

    // Outbound calls: the service announces its own mute and deafen through these.
    const wsCalls: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of [
        'invokeVoiceMuteChanged',
        'invokeVoiceDeafenChanged',
        'invokeVoiceCameraChanged',
        'invokeVoiceScreenShareStarted',
        'invokeVoiceScreenShareStopped',
        'invokeVoiceHeartbeat',
    ])
        wsCalls[name] = vi.fn();

    // The hub's connection state, as a signal so a test can drive the reconnect path.
    const connectionState = signal(ConnectionState.Connected);

    // Both answer for whichever channel was asked; a snapshot whose `roomId` mismatches is ignored.
    const guildVoice = {
        // Join answers with the room's authoritative state, same shape as the snapshot read.
        join: vi.fn((_g: string, channelId: string) => of(emptySnapshot(channelId))),
        leave: vi.fn(() => of(undefined)),
        getSnapshot: vi.fn((_g: string, channelId: string) => of(emptySnapshot(channelId))),
    };
    // Every member the service reads at construction: subjects it subscribes to and aliased signals.
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
        setScreenPreset: vi.fn(async () => null as {oldShareId: string; newShareId: string | null} | null),
        publishCamera: vi.fn(async () => 'video' as string | null),
        closeCamera: vi.fn(async () => undefined),
        publishScreen: vi.fn(async () => ({shareId: 'share-1'}) as {shareId: string} | null),
        closeScreen: vi.fn(async () => ({shareId: 'share-1'}) as {shareId: string} | null),
    };
    const toast = {info: vi.fn(), success: vi.fn(), error: vi.fn(), httpError: vi.fn()};
    const engineSetMute = vi.fn(async () => undefined);

    TestBed.configureTestingModule({
        providers: [
            {provide: GuildWebsocketService, useValue: {...wsCalls, connectionState}},
            {provide: RealtimeConnectionService, useValue: ws},
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
                // Both signals are read by effects at construction; an incomplete stub throws early.
                provide: VoiceEngineService,
                useValue: {speaking: () => false, remoteLevels: () => new Map(), setMute: engineSetMute},
            },
            {provide: ToastService, useValue: toast},
            // Echoes the key rather than loading real translations.
            {provide: TranslateService, useValue: {instant: (key: string) => key}},
            // The real VoiceLimitsService over a stubbed ceiling cache.
            {provide: EntitlementStore, useValue: {ladder: () => undefined, ensureLoaded: () => void 0}},
        ],
    });

    const service = TestBed.inject(VoiceChannelService);
    if (options.inChannel !== false) {
        service.joinedChannelId.set('chan-1');
        service.joinedGuildId.set('guild-1');
    }
    return {service, ws, wsCalls, guildVoice, rtc, toast, engineSetMute, connectionState};
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));

it('tears down without calling leave - the server already removed us', async () => {
    const {service, ws, guildVoice, rtc, toast} = setup();

    ws.emit('guild.voice.KickedByOtherDevice', {channelId: 'chan-1', guildId: 'guild-1'});
    await tick();

    expect(rtc.teardown).toHaveBeenCalled();
    expect(guildVoice.leave).not.toHaveBeenCalled();
    expect(service.joinedChannelId()).toBeNull();
    expect(service.joinedGuildId()).toBeNull();
    expect(toast.info).toHaveBeenCalledWith('You joined this channel from another device');
});

it('ignores a kick for a channel we are not in', async () => {
    const {service, ws, rtc} = setup();

    ws.emit('guild.voice.KickedByOtherDevice', {channelId: 'other-chan', guildId: 'guild-1'});
    await tick();

    expect(rtc.teardown).not.toHaveBeenCalled();
    expect(service.joinedChannelId()).toBe('chan-1');
});

/** A session cannot pull its own local track, so an announcement of ourselves must not subscribe. */
it('does not subscribe to our own audio when the server announces us', async () => {
    const {ws, rtc} = setup();

    ws.emit('guild.voice.ParticipantJoined', {
        channelId: 'chan-1',
        userId: 'me',
        mediaSessionId: 'sess-mine',
        audioTrackName: 'audio',
    });
    await tick();

    expect(rtc.subscribeAudio).not.toHaveBeenCalled();
});

it('still subscribes when somebody else is announced', async () => {
    const {ws, rtc} = setup();

    ws.emit('guild.voice.ParticipantJoined', {
        channelId: 'chan-1',
        userId: 'them',
        mediaSessionId: 'sess-theirs',
        audioTrackName: 'audio',
    });
    await tick();

    expect(rtc.subscribeAudio).toHaveBeenCalledWith([
        {userId: 'them', mediaSessionId: 'sess-theirs', trackName: 'audio'},
    ]);
});

describe('sticky mute and deafen', () => {
    const CHANNEL = {
        id: 'chan-2',
        guildId: 'guild-1',
        name: 'General',
        type: ChannelType.Voice,
    } as ChannelDto;
    const STORAGE_KEY = 'alpine_voice_local_state';

    // The unit-test environment's localStorage is a stub without `clear`.
    let restoreStorage: () => void;
    beforeEach(() => (restoreStorage = installMemoryStorage()));
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

        /** Neither can mean anything after a channel change: both hold a live publication. */
        it('never restores camera or screen share', () => {
            localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify({isMuted: true, isDeafened: false, isCameraOn: true, isScreenSharing: true}),
            );
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

        ws.emit('guild.voice.KickedByOtherDevice', {channelId: 'chan-1', guildId: 'guild-1'});
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

        const own = service
            .channelParticipants()
            .get(CHANNEL.id)
            ?.find(p => p.isLocal);
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
        // Without this the user hears everyone despite the button: syncMic only gates the outgoing mic.
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

        expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({
            isMuted: true,
            isDeafened: false,
        });
    });

    /** Deafening implies muting, and both halves have to survive a restart. */
    it('writes deafen through to storage together with the mute it forces', () => {
        const {service} = setup({inChannel: false});

        service.toggleDeafen();

        expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({
            isMuted: true,
            isDeafened: true,
        });
    });
});

describe('a join the server refuses', () => {
    const CHANNEL = {
        id: 'chan-2',
        guildId: 'guild-1',
        name: 'General',
        type: ChannelType.Voice,
    } as ChannelDto;

    /** A refusal shaped the way `Echo.Entitlements` sends one: 403, `code` equal to `reason`. */
    function entitlementRefusal(): HttpErrorResponse {
        return new HttpErrorResponse({
            status: 403,
            error: {
                code: 'guild_plan_limit',
                key: 'voice.max_participants',
                reason: 'guild_plan_limit',
                boundBy: 'guild',
                remedy: 'upgrade_guild',
                actorCanRemedy: false,
                subject: {kind: 'guild', id: 'guild-1'},
                retryable: false,
            },
        });
    }

    it('does not claim to have joined', async () => {
        const {service, guildVoice} = setup({inChannel: false});
        guildVoice.join.mockReturnValue(throwError(() => entitlementRefusal()));

        const joined = await service.joinChannel(CHANNEL, 'Guild');

        expect(joined).toBe(false);
        expect(service.joinedChannelId()).toBeNull();
        expect(service.joinedGuildId()).toBeNull();
        expect(service.joinedChannelName()).toBeNull();
        expect(service.isInVoice()).toBe(false);
    });

    /** The whole point: a refusal the user can read, rather than a line in the console. */
    it('says which limit bound, in the entitlement vocabulary', async () => {
        const {service, guildVoice, toast} = setup({inChannel: false});
        guildVoice.join.mockReturnValue(throwError(() => entitlementRefusal()));

        await service.joinChannel(CHANNEL, 'Guild');

        expect(toast.error).toHaveBeenCalledWith('ENTITLEMENT.REASON.GUILD_PLAN_LIMIT');
    });

    it('falls back to the generic sentence for a failure that is not an entitlement one', async () => {
        const {service, guildVoice, toast} = setup({inChannel: false});
        guildVoice.join.mockReturnValue(throwError(() => new HttpErrorResponse({status: 500})));

        await service.joinChannel(CHANNEL, 'Guild');

        expect(toast.error).toHaveBeenCalledWith('VOICE.JOIN_FAILED');
    });

    it('tells the server about the channel it left on the way in', async () => {
        const {service, guildVoice} = setup();
        guildVoice.join.mockReturnValue(throwError(() => entitlementRefusal()));

        await service.joinChannel(CHANNEL, 'Guild');

        expect(guildVoice.leave).toHaveBeenCalledWith('guild-1', 'chan-1');
    });

    /** A transport that never came up is a room with no audio in it, and not a room to stay in. */
    it('rolls back when the media transport does not come up', async () => {
        const {service, rtc, toast} = setup({inChannel: false});
        rtc.connect.mockResolvedValue(false);

        const joined = await service.joinChannel(CHANNEL, 'Guild');

        expect(joined).toBe(false);
        expect(service.joinedChannelId()).toBeNull();
        expect(toast.error).toHaveBeenCalledWith('VOICE.JOIN_FAILED');
    });

    it('reports a join that worked', async () => {
        const {service, toast} = setup({inChannel: false});

        const joined = await service.joinChannel(CHANNEL, 'Guild');

        expect(joined).toBe(true);
        expect(service.joinedChannelId()).toBe(CHANNEL.id);
        expect(toast.error).not.toHaveBeenCalled();
    });

    /** A degradation is a `200`: the room admitted us and gave less than was asked for. */
    it('stays in a room that admitted it on reduced terms, and holds what was reduced', async () => {
        const {service, guildVoice, toast} = setup({inChannel: false});
        guildVoice.join.mockReturnValue(
            of({
                ...emptySnapshot(CHANNEL.id),
                degradations: [
                    {
                        key: 'voice.video_ceiling',
                        requested: {kind: 'ladder', rung: '1080p60', rank: 4},
                        granted: {kind: 'ladder', rung: '720p30', rank: 2},
                        reason: 'guild_plan_limit',
                        boundBy: 'guild',
                        remedy: 'upgrade_guild',
                        actorCanRemedy: false,
                        subject: {kind: 'guild', id: 'guild-1'},
                    },
                ],
            }),
        );

        const joined = await service.joinChannel(CHANNEL, 'Guild');

        expect(joined).toBe(true);
        expect(service.joinedChannelId()).toBe(CHANNEL.id);
        expect(toast.error).not.toHaveBeenCalled();
        // Not a toast: a ceiling is the state of the room for as long as the call lasts.
        expect(toast.info).not.toHaveBeenCalled();
        expect(service.limits.notices()).toEqual([
            expect.objectContaining({
                key: 'voice.video_ceiling',
                messageKey: 'ENTITLEMENT.REASON.GUILD_PLAN_LIMIT',
                surfaceKey: 'VOICE.DEGRADED.QUALITY_CAPPED',
                rung: '720p30',
                // The server said this caller cannot act: a sentence naming who can, and no button.
                ctaKey: null,
                hintKey: 'ENTITLEMENT.CTA.ASK_OWNER',
            }),
        ]);
    });

    /** Absent and empty mean the same thing, and both are the normal case. */
    it('says nothing when nothing was reduced', async () => {
        const {service, toast} = setup({inChannel: false});

        await service.joinChannel(CHANNEL, 'Guild');

        expect(toast.info).not.toHaveBeenCalled();
        expect(service.limits.notices()).toEqual([]);
    });

    /** Nothing one room said about its plan may follow the user into the next one. */
    it("drops the last room's limits on leaving", async () => {
        const {service, guildVoice} = setup({inChannel: false});
        guildVoice.join.mockReturnValue(
            of({
                ...emptySnapshot(CHANNEL.id),
                degradations: [
                    {
                        key: 'voice.video_ceiling',
                        requested: {kind: 'ladder', rung: '1080p60', rank: 4},
                        granted: {kind: 'ladder', rung: 'none', rank: 0},
                        reason: 'guild_plan_limit',
                        remedy: 'upgrade_guild',
                        actorCanRemedy: true,
                        subject: {kind: 'guild', id: 'guild-1'},
                    },
                ],
            }),
        );

        await service.joinChannel(CHANNEL, 'Guild');
        expect(service.limits.notices()).toHaveLength(1);

        await service.leaveChannel();

        expect(service.limits.notices()).toEqual([]);
        expect(service.videoBlock(false)).toBeNull();
    });

    /** Already being there is a success. Callers gate their follow-up action on this. */
    it('reports true for the channel it is already in', async () => {
        const {service, guildVoice} = setup();

        const joined = await service.joinChannel({...CHANNEL, id: 'chan-1'} as ChannelDto, 'Guild');

        expect(joined).toBe(true);
        expect(guildVoice.join).not.toHaveBeenCalled();
    });
});

describe('screen share backfill from the snapshot', () => {
    it('subscribes to a share that was already running when we arrived', async () => {
        const {ws, rtc} = setup();

        ws.emit('guild.voice.Snapshot', {
            ...emptySnapshot('chan-1'),
            participants: [
                publisher('them', {
                    isStreaming: true,
                    shares: [{shareId: 'abc', trackNames: ['screen-abc'], mediaSessionId: 'cf-screen-them'}],
                }),
            ],
        });
        await tick();

        // The share's own session, not `cf-them`: a share is published on a session of its own.
        expect(rtc.subscribeVideo).toHaveBeenCalledWith(
            'guild-1',
            'chan-1',
            'them',
            'cf-screen-them',
            'screen-abc',
            'screen',
        );
    });

    /** A share can carry audio, and the two halves are one share tied by the same id. */
    it('subscribes to both halves of a share with audio', async () => {
        const {ws, rtc} = setup();

        ws.emit('guild.voice.Snapshot', {
            ...emptySnapshot('chan-1'),
            participants: [
                publisher('them', {
                    isStreaming: true,
                    shares: [
                        {
                            shareId: 'abc',
                            trackNames: ['screen-abc', 'screen-audio-abc'],
                            mediaSessionId: 'cf-screen-them',
                        },
                    ],
                }),
            ],
        });
        await tick();

        expect(rtc.subscribeVideo).toHaveBeenCalledWith(
            'guild-1',
            'chan-1',
            'them',
            'cf-screen-them',
            'screen-abc',
            'screen',
        );
        expect(rtc.subscribeAudio).toHaveBeenCalledWith([
            {
                userId: 'them',
                mediaSessionId: 'cf-screen-them',
                trackName: 'screen-audio-abc',
                kind: 'screenAudio',
            },
        ]);
    });

    /** `Joined` means a session exists and a microphone track does not. */
    it('does not subscribe to a participant who has only opened a session', async () => {
        const {ws, rtc} = setup();

        ws.emit('guild.voice.Snapshot', {
            ...emptySnapshot('chan-1'),
            participants: [
                publisher('them', {
                    publishState: 'Joined',
                    mediaSessionId: null,
                    audioTrackName: null,
                }),
            ],
        });
        await tick();

        expect(rtc.subscribeAudio).not.toHaveBeenCalled();
    });

    /** `publishState` carries the meaning, not the null handles: a client keyed on nulls subscribes too early. */
    it('does not subscribe on a session id alone, even if the handles are present', async () => {
        const {ws, rtc} = setup();

        ws.emit('guild.voice.Snapshot', {
            ...emptySnapshot('chan-1'),
            participants: [publisher('them', {publishState: 'Joined'})],
        });
        await tick();

        expect(rtc.subscribeAudio).not.toHaveBeenCalled();
    });

    /** Our own session cannot pull its own local track: the SFU refuses, on every retry. */
    it('does not subscribe to ourselves', async () => {
        const {ws, rtc} = setup();

        ws.emit('guild.voice.Snapshot', {
            ...emptySnapshot('chan-1'),
            participants: [
                publisher('me', {
                    isStreaming: true,
                    shares: [
                        {shareId: 'mine', trackNames: ['screen-mine'], mediaSessionId: 'cf-screen-mine'},
                    ],
                }),
            ],
        });
        await tick();

        expect(rtc.subscribeAudio).not.toHaveBeenCalled();
        expect(rtc.subscribeVideo).not.toHaveBeenCalled();
    });

    /** `videoTracks[]` carries a session of its own: what published a camera need not be the mic's session. */
    it('subscribes to a camera that was already on when we arrived', async () => {
        const {ws, rtc} = setup();

        ws.emit('guild.voice.Snapshot', {
            ...emptySnapshot('chan-1'),
            participants: [
                publisher('them', {
                    videoTracks: [{trackName: 'camera', mediaSessionId: 'cf-camera-them'}],
                }),
            ],
        });
        await tick();

        expect(rtc.subscribeVideo).toHaveBeenCalledWith(
            'guild-1',
            'chan-1',
            'them',
            'cf-camera-them',
            'camera',
            'video',
        );
    });

    it('marks a camera the snapshot reports as on', async () => {
        const {service, ws} = setup();

        ws.emit('guild.voice.Snapshot', {
            ...emptySnapshot('chan-1'),
            participants: [
                publisher('them', {
                    videoTracks: [{trackName: 'camera', mediaSessionId: 'cf-camera-them'}],
                }),
            ],
        });
        await tick();

        expect(
            service
                .channelParticipants()
                .get('chan-1')
                ?.find(p => p.userId === 'them')?.isCameraOn,
        ).toBe(true);
    });

    /** They are on camera whether or not we can pull it: the mark is about them, not about us. */
    it('marks a camera whose publishing session was never recorded', async () => {
        const {service, ws} = setup();

        ws.emit('guild.voice.Snapshot', {
            ...emptySnapshot('chan-1'),
            participants: [publisher('them', {videoTracks: [{trackName: 'camera', mediaSessionId: null}]})],
        });
        await tick();

        expect(
            service
                .channelParticipants()
                .get('chan-1')
                ?.find(p => p.userId === 'them')?.isCameraOn,
        ).toBe(true);
    });

    it('leaves the camera mark off when the snapshot reports no video', async () => {
        const {service, ws} = setup();

        ws.emit('guild.voice.Snapshot', {
            ...emptySnapshot('chan-1'),
            participants: [publisher('them')],
        });
        await tick();

        expect(
            service
                .channelParticipants()
                .get('chan-1')
                ?.find(p => p.userId === 'them')?.isCameraOn,
        ).toBe(false);
    });

    /** `video`, not `screen`: the kind decides the tile layout, and the share loop hardcodes `'screen'`. */
    it('subscribes a camera alongside a share without confusing the two', async () => {
        const {ws, rtc} = setup();

        ws.emit('guild.voice.Snapshot', {
            ...emptySnapshot('chan-1'),
            participants: [
                publisher('them', {
                    isStreaming: true,
                    shares: [{shareId: 'abc', trackNames: ['screen-abc'], mediaSessionId: 'cf-screen-them'}],
                    videoTracks: [{trackName: 'camera', mediaSessionId: 'cf-them'}],
                }),
            ],
        });
        await tick();

        expect(rtc.subscribeVideo).toHaveBeenCalledWith(
            'guild-1',
            'chan-1',
            'them',
            'cf-screen-them',
            'screen-abc',
            'screen',
        );
        expect(rtc.subscribeVideo).toHaveBeenCalledWith(
            'guild-1',
            'chan-1',
            'them',
            'cf-them',
            'camera',
            'video',
        );
    });

    /** Our own camera, for the same reason as our own share: a session cannot pull its own track. */
    it('does not subscribe to our own camera', async () => {
        const {ws, rtc} = setup();

        ws.emit('guild.voice.Snapshot', {
            ...emptySnapshot('chan-1'),
            participants: [
                publisher('me', {
                    videoTracks: [{trackName: 'camera', mediaSessionId: 'cf-me'}],
                }),
            ],
        });
        await tick();

        expect(rtc.subscribeVideo).not.toHaveBeenCalled();
    });

    /** A missing `videoTracks` must not throw and take the rest of the snapshot down with it. */
    it('applies a snapshot from a server that does not send videoTracks', async () => {
        const {ws, rtc} = setup();

        ws.emit('guild.voice.Snapshot', {
            ...emptySnapshot('chan-1'),
            participants: [
                publisher('them', {
                    isStreaming: true,
                    shares: [{shareId: 'abc', trackNames: ['screen-abc'], mediaSessionId: 'cf-screen-them'}],
                }),
            ],
        });
        await tick();

        expect(rtc.subscribeVideo).toHaveBeenCalledWith(
            'guild-1',
            'chan-1',
            'them',
            'cf-screen-them',
            'screen-abc',
            'screen',
        );
        expect(rtc.subscribeVideo).toHaveBeenCalledTimes(1);
    });

    /** A null video session must not fall back to the microphone's: the handle is genuinely unknown. */
    it('skips a camera whose publishing session was never recorded', async () => {
        const {ws, rtc} = setup();

        ws.emit('guild.voice.Snapshot', {
            ...emptySnapshot('chan-1'),
            participants: [
                publisher('them', {
                    videoTracks: [{trackName: 'camera', mediaSessionId: null}],
                }),
            ],
        });
        await tick();

        expect(rtc.subscribeVideo).not.toHaveBeenCalled();
    });

    it('drops anyone the snapshot says is no longer here', async () => {
        const {ws, rtc} = setup();
        rtc.subscribedUserIds.mockReturnValue(['gone', 'them']);

        ws.emit('guild.voice.Snapshot', {
            ...emptySnapshot('chan-1'),
            participants: [publisher('them')],
        });
        await tick();

        expect(rtc.cleanupParticipant).toHaveBeenCalledWith('gone');
        expect(rtc.cleanupParticipant).not.toHaveBeenCalledWith('them');
    });

    it('subscribes from the snapshot the join call returns', async () => {
        const {service, guildVoice, rtc} = setup({inChannel: false});
        guildVoice.join.mockReturnValue(
            of({
                ...emptySnapshot('chan-1'),
                participants: [
                    publisher('them', {
                        isStreaming: true,
                        shares: [
                            {shareId: 'abc', trackNames: ['screen-abc'], mediaSessionId: 'cf-screen-them'},
                        ],
                    }),
                ],
            }),
        );

        await service.joinChannel(
            {id: 'chan-1', guildId: 'guild-1', name: 'General', type: ChannelType.Voice} as ChannelDto,
            'Guild',
        );

        expect(rtc.subscribeVideo).toHaveBeenCalledWith(
            'guild-1',
            'chan-1',
            'them',
            'cf-screen-them',
            'screen-abc',
            'screen',
        );
    });

    /** LiveKit sends a null `mediaSessionId`: fall back to the user id, which is the primary connection's identity. */
    it('backfills a publisher whose snapshot row carries no media session', async () => {
        const {service, guildVoice, rtc} = setup({inChannel: false});
        guildVoice.join.mockReturnValue(
            of({
                ...emptySnapshot('chan-1'),
                participants: [publisher('them', {mediaSessionId: null})],
            }),
        );

        await service.joinChannel(
            {id: 'chan-1', guildId: 'guild-1', name: 'General', type: ChannelType.Voice} as ChannelDto,
            'Guild',
        );

        expect(rtc.subscribeAudio).toHaveBeenCalledWith([
            {userId: 'them', mediaSessionId: 'them', trackName: 'audio'},
        ]);
    });

    /** A real session id still wins: falling back unconditionally would address the wrong connection. */
    it('prefers the snapshot media session over the user id when one is present', async () => {
        const {service, guildVoice, rtc} = setup({inChannel: false});
        guildVoice.join.mockReturnValue(
            of({
                ...emptySnapshot('chan-1'),
                participants: [publisher('them')],
            }),
        );

        await service.joinChannel(
            {id: 'chan-1', guildId: 'guild-1', name: 'General', type: ChannelType.Voice} as ChannelDto,
            'Guild',
        );

        expect(rtc.subscribeAudio).toHaveBeenCalledWith([
            {userId: 'them', mediaSessionId: 'cf-them', trackName: 'audio'},
        ]);
    });

    /** Loosening the `mediaSessionId` requirement must not loosen this one: `Joined` has published nothing. */
    it('still skips a participant who has not published', async () => {
        const {service, guildVoice, rtc} = setup({inChannel: false});
        guildVoice.join.mockReturnValue(
            of({
                ...emptySnapshot('chan-1'),
                participants: [
                    publisher('them', {
                        publishState: 'Joined',
                        mediaSessionId: null,
                        audioTrackName: null,
                    }),
                ],
            }),
        );

        await service.joinChannel(
            {id: 'chan-1', guildId: 'guild-1', name: 'General', type: ChannelType.Voice} as ChannelDto,
            'Guild',
        );

        expect(rtc.subscribeAudio).not.toHaveBeenCalled();
    });

    /** A full join applies two snapshots, and the roster is replaced wholesale by each. */
    it('keeps us in the roster across every snapshot, not just the join one', async () => {
        const {service, guildVoice} = setup({inChannel: false});
        guildVoice.join.mockReturnValue(of(emptySnapshot('chan-1')));
        guildVoice.getSnapshot.mockReturnValue(of(emptySnapshot('chan-1')));

        await service.joinChannel(
            {id: 'chan-1', guildId: 'guild-1', name: 'General', type: ChannelType.Voice} as ChannelDto,
            'Guild',
        );
        await tick();

        expect(
            service
                .channelParticipants()
                .get('chan-1')
                ?.some(p => p.isLocal),
        ).toBe(true);
    });

    it('ignores a snapshot for a channel we are not in', async () => {
        const {ws, rtc} = setup();

        ws.emit('guild.voice.Snapshot', {
            ...emptySnapshot('other-chan'),
            participants: [publisher('them')],
        });
        await tick();

        expect(rtc.subscribeAudio).not.toHaveBeenCalled();
    });
});

describe('version recovery', () => {
    it('refetches the snapshot when an event arrives with a gap in the version', async () => {
        const {ws, guildVoice} = setup();

        ws.emit('guild.voice.Snapshot', emptySnapshot('chan-1'));
        await tick();
        guildVoice.getSnapshot.mockClear();

        ws.emit('guild.voice.MuteChanged', {
            channelId: 'chan-1',
            userId: 'them',
            isMuted: true,
            serverForced: false,
            instanceId: 'inst-1',
            version: 4,
        });
        await tick();

        expect(guildVoice.getSnapshot).toHaveBeenCalledWith('guild-1', 'chan-1');
    });

    it('applies an event that is exactly the next one without refetching', async () => {
        const {ws, guildVoice} = setup();

        ws.emit('guild.voice.Snapshot', emptySnapshot('chan-1'));
        await tick();
        guildVoice.getSnapshot.mockClear();

        ws.emit('guild.voice.ParticipantJoined', {
            channelId: 'chan-1',
            userId: 'them',
            mediaSessionId: 'cf-them',
            audioTrackName: 'audio',
            instanceId: 'inst-1',
            version: 2,
        });
        await tick();

        expect(guildVoice.getSnapshot).not.toHaveBeenCalled();
    });

    /** A rebuilt room climbs from zero, so the version alone reads as perfectly in sequence. */
    it('refetches when the room was rebuilt under us', async () => {
        const {ws, guildVoice} = setup();

        ws.emit('guild.voice.Snapshot', emptySnapshot('chan-1'));
        await tick();
        guildVoice.getSnapshot.mockClear();

        ws.emit('guild.voice.MuteChanged', {
            channelId: 'chan-1',
            userId: 'them',
            isMuted: true,
            serverForced: false,
            instanceId: 'inst-2',
            version: 2,
        });
        await tick();

        expect(guildVoice.getSnapshot).toHaveBeenCalled();
    });

    /** Not "silently rejoin": re-admitting ourselves would readmit anyone kicked, banned or denied Connect. */
    it('leaves the channel locally when the room is gone', async () => {
        const {service, ws, rtc, toast} = setup();

        ws.emit('guild.voice.Resync', {channelId: 'chan-1', reason: 'roomGone'});
        await tick();

        expect(rtc.teardown).toHaveBeenCalled();
        expect(service.joinedChannelId()).toBeNull();
        expect(toast.info).toHaveBeenCalledWith('Voice channel is no longer available');
    });

    it('refetches rather than leaving on every other resync reason', async () => {
        const {service, ws, guildVoice} = setup();

        ws.emit('guild.voice.Resync', {channelId: 'chan-1', reason: 'participantLeft', userId: 'them'});
        await tick();

        expect(guildVoice.getSnapshot).toHaveBeenCalled();
        expect(service.joinedChannelId()).toBe('chan-1');
    });
});

/** A stale refusal is not an error to back off from: the track is gone, so read the room again. */
describe('a subscribe the server refuses as stale', () => {
    it('refetches the snapshot', async () => {
        const {ws, rtc, guildVoice} = setup();

        ws.emit('guild.voice.Snapshot', emptySnapshot('chan-1'));
        await tick();
        guildVoice.getSnapshot.mockClear();

        rtc.staleSubscription$.next({userId: 'them'});
        await tick();

        expect(guildVoice.getSnapshot).toHaveBeenCalledWith('guild-1', 'chan-1');
    });

    /** Several refusals in a row are one stale roster, and cost one read. */
    it('does not read the room once per refusal', async () => {
        const {ws, rtc, guildVoice} = setup();

        ws.emit('guild.voice.Snapshot', emptySnapshot('chan-1'));
        await tick();
        guildVoice.getSnapshot.mockClear();

        rtc.staleSubscription$.next({userId: 'a'});
        rtc.staleSubscription$.next({userId: 'b'});
        rtc.staleSubscription$.next({userId: 'c'});
        await tick();

        expect(guildVoice.getSnapshot).toHaveBeenCalledTimes(1);
    });
});

describe('heartbeat', () => {
    it('asserts the tracked version and the session we actually publish on', async () => {
        const {ws, rtc, wsCalls, service} = setup();
        rtc.publishedMedia = {mediaSessionId: 'cf-rust', audioTrackName: 'audio'};

        ws.emit('guild.voice.Snapshot', {...emptySnapshot('chan-1'), version: 7});
        await tick();
        (service as unknown as {sendHeartbeat(id: string): void}).sendHeartbeat('chan-1');

        expect(wsCalls['invokeVoiceHeartbeat']).toHaveBeenCalledWith('chan-1', {
            knownInstanceId: 'inst-1',
            knownVersion: 7,
            mediaSessionId: 'cf-rust',
            audioTrackName: 'audio',
        });
    });

    /** Honest nulls: the server corrects its record from them and tells peers to drop us. */
    it('reports null handles when not publishing', () => {
        const {wsCalls, service} = setup();

        (service as unknown as {sendHeartbeat(id: string): void}).sendHeartbeat('chan-1');

        expect(wsCalls['invokeVoiceHeartbeat']).toHaveBeenCalledWith('chan-1', {
            knownInstanceId: null,
            knownVersion: 0,
            mediaSessionId: null,
            audioTrackName: null,
        });
    });
});

/** A dropped socket is not a departure: assert immediately, and never rebuild the media on a websocket blip. */
describe('a hub reconnect', () => {
    /** Angular flushes effects on the microtask queue, so a signal write needs a turn to land. */
    const settle = () => TestBed.inject(ApplicationRef).tick();

    it('asserts our state as soon as the socket is back', async () => {
        const {wsCalls, connectionState} = setup();
        settle();
        wsCalls['invokeVoiceHeartbeat'].mockClear();

        connectionState.set(ConnectionState.Disconnected);
        settle();
        connectionState.set(ConnectionState.Connected);
        settle();

        expect(wsCalls['invokeVoiceHeartbeat']).toHaveBeenCalledTimes(1);
    });

    it('does not touch the media when the socket blips', () => {
        const {rtc, connectionState} = setup();

        connectionState.set(ConnectionState.Disconnected);
        settle();
        connectionState.set(ConnectionState.Connected);
        settle();

        expect(rtc.teardown).not.toHaveBeenCalled();
        expect(rtc.connect).not.toHaveBeenCalled();
    });

    /** Only the transition into Connected. A repeated report is not a reconnect. */
    it('does not re-assert on a state that was already connected', () => {
        const {wsCalls, connectionState} = setup();
        settle();
        wsCalls['invokeVoiceHeartbeat'].mockClear();

        connectionState.set(ConnectionState.Connected);
        settle();

        expect(wsCalls['invokeVoiceHeartbeat']).not.toHaveBeenCalled();
    });

    it('stays quiet when not in a channel', () => {
        const {wsCalls, connectionState} = setup({inChannel: false});
        settle();

        connectionState.set(ConnectionState.Disconnected);
        settle();
        connectionState.set(ConnectionState.Connected);
        settle();

        expect(wsCalls['invokeVoiceHeartbeat']).not.toHaveBeenCalled();
    });
});

/** The share id never moves across a quality change, so announcing one would take every viewer's tile down. */
describe('changing stream quality mid-share', () => {
    const preset = {resolution: '1440p', framerate: 30, content: 'text'} as const;

    it('announces nothing to the room', async () => {
        const {service, rtc, wsCalls} = setup();

        await service.setScreenPreset(preset);

        expect(rtc.setScreenPreset).toHaveBeenCalledWith(preset);
        expect(wsCalls['invokeVoiceScreenShareStopped']).not.toHaveBeenCalled();
        expect(wsCalls['invokeVoiceScreenShareStarted']).not.toHaveBeenCalled();
    });

    it('does nothing at all outside a channel', async () => {
        const {service, rtc} = setup({inChannel: false});

        await service.setScreenPreset(preset);

        expect(rtc.setScreenPreset).not.toHaveBeenCalled();
    });
});

/** The pre-flight must never spend a `getUserMedia` prompt or a source picker on a publish already refused. */
describe('starting video in a room that will not carry it', () => {
    const CHANNEL = {
        id: 'chan-3',
        guildId: 'guild-1',
        name: 'General',
        type: ChannelType.Voice,
    } as ChannelDto;

    /** Joins with a limits block, through the real path rather than by reaching into the service. */
    async function joinWith(limits: Record<string, unknown>) {
        const harness = setup({inChannel: false});
        harness.guildVoice.join.mockReturnValue(of({...emptySnapshot(CHANNEL.id), limits}));
        await harness.service.joinChannel(CHANNEL, 'Guild');
        return harness;
    }

    const AUDIO_ONLY = {videoCeiling: {kind: 'ladder', rung: 'none', rank: 0}};
    const PUBLISHERS_FULL = {
        maxPublishers: {kind: 'numeric', value: 2, unlimited: false},
        publisherCount: 2,
    };

    it('names audio-only and starts nothing', async () => {
        const {service, rtc} = await joinWith(AUDIO_ONLY);

        expect(service.videoBlock(false)).toBe('audio_only');

        await service.toggleCamera();
        await service.toggleScreenShare();

        expect(rtc.publishCamera).not.toHaveBeenCalled();
        // The picker never opens either: a dialog for a publish that cannot happen is worse than no button.
        expect(rtc.publishScreen).not.toHaveBeenCalled();
        expect(service.localState().isCameraOn).toBe(false);
    });

    it('names a full publisher list, which is a queue rather than a refusal', async () => {
        const {service, rtc} = await joinWith(PUBLISHERS_FULL);

        expect(service.videoBlock(false)).toBe('publishers_full');
        expect(service.limits.publisherSlots()).toEqual({used: 2, max: 2});

        await service.toggleScreenShare();

        expect(rtc.publishScreen).not.toHaveBeenCalled();
    });

    /** Stopping is never blocked: a ceiling that lands mid-share must not strand a live publish. */
    it('still stops a share that was already running when the ceiling arrived', async () => {
        const {service, rtc} = await joinWith(AUDIO_ONLY);
        service.localState.update(s => ({...s, isScreenSharing: true}));

        await service.toggleScreenShare();

        expect(rtc.closeScreen).toHaveBeenCalled();
        expect(service.localState().isScreenSharing).toBe(false);
    });

    /** Negative: a room that stated no limits blocks nothing, which is every instance today. */
    it('starts video normally in a room that stated no limits', async () => {
        const {service, rtc} = setup({inChannel: false});
        await service.joinChannel(CHANNEL, 'Guild');

        expect(service.videoBlock(false)).toBeNull();

        await service.toggleCamera();

        expect(rtc.publishCamera).toHaveBeenCalled();
        expect(service.localState().isCameraOn).toBe(true);
    });

    it('acknowledges a refusal that beat the pre-flight, by name', async () => {
        const {service, toast} = setup();

        service.limits.noteDenial(
            new HttpErrorResponse({
                status: 403,
                error: {
                    code: 'guild_plan_limit',
                    key: 'voice.video_ceiling',
                    reason: 'guild_plan_limit',
                    boundBy: 'guild',
                    remedy: 'upgrade_guild',
                    actorCanRemedy: true,
                    subject: {kind: 'guild', id: 'guild-1'},
                    retryable: false,
                },
            }),
        );

        expect(toast.error).toHaveBeenCalledWith('ENTITLEMENT.REASON.GUILD_PLAN_LIMIT');
        expect(service.limits.notices()).toHaveLength(1);
    });
});

/** A screen track closing is not a share ending: the seat is held for `SCREEN_RESUME_GRACE_MS`. */
describe('a screen track closing', () => {
    /** Fake timers go in after the seed, not before: `tick()` is a real `setTimeout(0)`. */
    async function sharingChannel() {
        const harness = setup();
        harness.ws.emit('guild.voice.Snapshot', {
            ...emptySnapshot('chan-1'),
            participants: [
                publisher('them', {
                    isStreaming: true,
                    shares: [{shareId: 'abc', trackNames: ['screen-abc'], mediaSessionId: 'cf-screen-them'}],
                }),
            ],
        });
        await tick();
        vi.useFakeTimers();
        return harness;
    }

    function closeScreenTrack(ws: FakeRealtimeConnection): void {
        ws.emit('guild.voice.TrackClosed', {channelId: 'chan-1', userId: 'them', trackName: 'screen-abc'});
    }

    function announceShare(ws: FakeRealtimeConnection, shareId: string): void {
        ws.emit('guild.voice.ScreenShareStarted', {
            channelId: 'chan-1',
            userId: 'them',
            trackName: `screen-${shareId}`,
            shareId,
        });
    }

    /** Whether the roster still has this person down as sharing, which is what the stage reads. */
    function stillSharing(service: VoiceChannelService): boolean {
        return (service.channelParticipants().get('chan-1') ?? []).some(
            p => p.userId === 'them' && p.isScreenSharing,
        );
    }

    afterEach(() => vi.useRealTimers());

    it('holds the seat rather than taking the sharer off the stage', async () => {
        const {service, ws} = await sharingChannel();

        closeScreenTrack(ws);

        expect(service.isScreenResuming('them')).toBe(true);
        expect(stillSharing(service)).toBe(true);
    });

    it('ends the share once nothing has come back in time', async () => {
        const {service, ws} = await sharingChannel();

        closeScreenTrack(ws);
        // Still up just before the window closes, so a client that drops the share on the spot fails here.
        vi.advanceTimersByTime(SCREEN_RESUME_GRACE_MS - 1);
        expect(stillSharing(service)).toBe(true);

        vi.advanceTimersByTime(2);

        expect(service.isScreenResuming('them')).toBe(false);
        expect(stillSharing(service)).toBe(false);
    });

    it('adopts a replacement that arrives inside the window', async () => {
        const {service, ws} = await sharingChannel();

        closeScreenTrack(ws);
        vi.advanceTimersByTime(SCREEN_RESUME_GRACE_MS / 2);
        announceShare(ws, 'def');

        expect(service.isScreenResuming('them')).toBe(false);
        expect(stillSharing(service)).toBe(true);
    });

    it('does not end an adopted share when the original window would have expired', async () => {
        // The timer has to be cancelled, not merely ignored: a late expiry clears `isScreenSharing`
        // out from under a stream that is playing perfectly well.
        const {service, ws} = await sharingChannel();

        closeScreenTrack(ws);
        announceShare(ws, 'def');
        vi.advanceTimersByTime(SCREEN_RESUME_GRACE_MS * 2);

        expect(stillSharing(service)).toBe(true);
    });

    it('drops held seats on the way out of the channel', async () => {
        // An expiry firing after the roster is gone would patch a channel this client has left.
        const {service, ws} = await sharingChannel();

        closeScreenTrack(ws);
        await service.leaveChannel();
        vi.advanceTimersByTime(SCREEN_RESUME_GRACE_MS * 2);

        expect(service.isScreenResuming('them')).toBe(false);
    });
});

describe('leaving a channel', () => {
    it('is out of the channel before the network answers', () => {
        const {service, rtc} = setup();
        // Never settles: stands in for the teardown and the leave request still being in flight.
        rtc.closeAllTracks.mockReturnValue(new Promise<undefined>(() => {}));

        void service.leaveChannel();

        expect(service.joinedChannelId()).toBeNull();
        expect(service.joinedGuildId()).toBeNull();
        expect(service.isInVoice()).toBe(false);
    });

    /** The half that must survive the reordering: the server still has to be told. */
    it('still tears the transport down and tells the server', async () => {
        const {service, guildVoice, rtc} = setup();

        await service.leaveChannel();

        expect(rtc.teardown).toHaveBeenCalled();
        expect(guildVoice.leave).toHaveBeenCalledWith('guild-1', 'chan-1');
    });

    /** Leave and join must be serialised: `rtc.teardown()` closes whatever peer connection it finds. */
    it('does not connect the next channel over a teardown that is still running', async () => {
        const {service, rtc} = setup();
        let finishTeardown: () => void = () => void 0;
        rtc.closeAllTracks.mockReturnValue(
            new Promise<undefined>(resolve => {
                finishTeardown = () => resolve(undefined);
            }),
        );

        void service.leaveChannel();
        const joining = service.joinChannel(
            {id: 'chan-2', guildId: 'guild-1', name: 'General', type: ChannelType.Voice} as ChannelDto,
            'Guild',
        );
        await tick();

        expect(rtc.connect).not.toHaveBeenCalled();

        finishTeardown();
        await joining;

        expect(rtc.connect).toHaveBeenCalledWith('guild-1', 'chan-2');
    });
});

/** A second join of any channel must be refused: two in flight race over one set of joined-state signals. */
describe('a join in flight', () => {
    const CHANNEL = {
        id: 'chan-2',
        guildId: 'guild-1',
        name: 'General',
        type: ChannelType.Voice,
    } as ChannelDto;
    const OTHER = {
        id: 'chan-3',
        guildId: 'guild-1',
        name: 'Gaming',
        type: ChannelType.Voice,
    } as ChannelDto;

    it('names the channel it is joining until the join settles', async () => {
        const {service, guildVoice} = setup({inChannel: false});
        const answer = new Subject<VoiceRoomSnapshot>();
        guildVoice.join.mockReturnValue(answer);

        const joining = service.joinChannel(CHANNEL, 'Guild');
        expect(service.pendingJoinId()).toBe(CHANNEL.id);

        answer.next(emptySnapshot(CHANNEL.id));
        answer.complete();
        await joining;

        expect(service.pendingJoinId()).toBeNull();
    });

    it('clears the pending id when the join is refused', async () => {
        const {service, guildVoice} = setup({inChannel: false});
        guildVoice.join.mockReturnValue(throwError(() => new HttpErrorResponse({status: 500})));

        await service.joinChannel(CHANNEL, 'Guild');

        expect(service.pendingJoinId()).toBeNull();
    });

    it('refuses a second join whatever channel it is for', async () => {
        const {service, guildVoice} = setup({inChannel: false});
        guildVoice.join.mockReturnValue(new Subject<VoiceRoomSnapshot>());

        void service.joinChannel(CHANNEL, 'Guild');
        const second = await service.joinChannel(OTHER, 'Guild');

        expect(second).toBe(false);
        expect(guildVoice.join).toHaveBeenCalledTimes(1);
    });
});

/** Voice teardown is keyed on user but the events carry a room, so every departure needs a room guard. */
describe('a self-addressed UserLeftVoice', () => {
    it('clears the ghost row for a channel we are not in', async () => {
        const {service, ws} = setup({inChannel: false});

        // The sidebar was painted from a snapshot taken before the sweep ran.
        ws.emit('guild.voice.UserJoinedVoice', {userId: 'them', channelId: 'ghost-chan', guildId: 'guild-1'});
        ws.emit('guild.voice.UserLeftVoice', {userId: 'me', channelId: 'ghost-chan', guildId: 'guild-1'});
        await tick();

        expect(
            service
                .channelParticipants()
                .get('ghost-chan')
                ?.map(p => p.userId),
        ).not.toContain('me');
    });

    it('is ignored for the channel we are in', async () => {
        const {service, ws, rtc} = setup();
        await tick();

        const before = service.channelParticipants().get('chan-1');
        ws.emit('guild.voice.UserLeftVoice', {userId: 'me', channelId: 'chan-1', guildId: 'guild-1'});
        await tick();

        expect(service.channelParticipants().get('chan-1')).toBe(before);
        expect(service.joinedChannelId()).toBe('chan-1');
        expect(rtc.cleanupParticipant).not.toHaveBeenCalled();
    });

    it('never tears down our own subscriptions, which are keyed on user and not on room', async () => {
        const {ws, rtc} = setup();

        // `cleanupParticipant('me')` here would reach into the room we are actually sitting in.
        ws.emit('guild.voice.UserLeftVoice', {userId: 'me', channelId: 'ghost-chan', guildId: 'guild-1'});
        await tick();

        expect(rtc.cleanupParticipant).not.toHaveBeenCalled();
    });

    /** `cleanupParticipant` is keyed on user, not room: another user's departure elsewhere must not fire it. */
    it('never tears down another user in our channel because they left a different one', async () => {
        const {ws, rtc} = setup();

        // They are in chan-1 with us. This event is about the seat they gave up elsewhere.
        ws.emit('guild.voice.UserLeftVoice', {userId: 'them', channelId: 'ghost-chan', guildId: 'guild-1'});
        await tick();

        expect(rtc.cleanupParticipant).not.toHaveBeenCalled();
    });

    /** The sidebar is the reason the event is applied for other channels at all, so it must stay. */
    it('still corrects the sidebar for a channel we are not in', async () => {
        const {service, ws} = setup();

        ws.emit('guild.voice.UserJoinedVoice', {userId: 'them', channelId: 'ghost-chan', guildId: 'guild-1'});
        ws.emit('guild.voice.UserLeftVoice', {userId: 'them', channelId: 'ghost-chan', guildId: 'guild-1'});
        await tick();

        expect(
            service
                .channelParticipants()
                .get('ghost-chan')
                ?.map(p => p.userId),
        ).not.toContain('them');
    });

    /** And a real departure from the room we are in still unwinds everything held for them. */
    it('tears down a user who leaves the channel we are in', async () => {
        const {ws, rtc} = setup();

        ws.emit('guild.voice.UserLeftVoice', {userId: 'them', channelId: 'chan-1', guildId: 'guild-1'});
        await tick();

        expect(rtc.cleanupParticipant).toHaveBeenCalledWith('them');
    });
});
