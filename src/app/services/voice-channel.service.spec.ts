/**
 * Bug this fixes: joining the same channel from a second device did not kick the first, so both
 * fought over one media session and the first device's audio silently broke. The kick is entirely
 * server-driven; the client's only job is to tear down cleanly when told.
 */
import {ApplicationRef, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {TestBed} from '@angular/core/testing';
import {TranslateService} from '@ngx-translate/core';
import {of, Subject, throwError} from 'rxjs';
import {loadStickyVoiceState, VoiceChannelService} from './voice-channel.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {ConnectionState} from './realtime-connection.service';
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

/** A room at v1 with nobody in it - what most of these tests want the recovery path to return. */
function emptySnapshot(roomId: string): VoiceRoomSnapshot {
    return {
        roomId, kind: 'channel', guildId: 'guild-1',
        instanceId: 'inst-1', version: 1, participants: [],
    };
}

function publisher(userId: string, over: Partial<VoiceParticipantSnapshot> = {}): VoiceParticipantSnapshot {
    return {
        userId,
        mediaSessionId: `cf-${userId}`,
        audioTrackName: 'audio',
        publishState: 'Publishing',
        isSelfMuted: false, isSelfDeafened: false,
        isServerMuted: false, isServerDeafened: false,
        isStreaming: false,
        shares: [],
        joinedAt: '2026-08-07T12:00:00Z',
        ...over,
    };
}

function setup(options: {inChannel?: boolean} = {}) {
    const ws: Record<string, Subject<unknown>> = {};
    for (const name of [
        'userJoinedVoiceObservable', 'userLeftVoiceObservable', 'guildParticipantJoinedObservable',
        'guildTrackPublishedObservable', 'guildTrackClosedObservable', 'voiceMuteChangedObservable',
        'voiceDeafenChangedObservable', 'voiceCameraChangedObservable',
        'voiceScreenShareStartedObservable', 'voiceScreenShareStoppedObservable',
        'movedToChannelObservable', 'kickedByOtherDeviceObservable',
        'voiceSnapshotObservable', 'voiceResyncObservable',
    ]) ws[name] = new Subject();

    // Outbound calls, as opposed to the subjects above. The service announces its own mute and
    // deafen through these, which is the only way the rest of the room learns about either.
    const wsCalls: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of [
        'invokeVoiceMuteChanged', 'invokeVoiceDeafenChanged', 'invokeVoiceCameraChanged',
        'invokeVoiceScreenShareStarted', 'invokeVoiceScreenShareStopped', 'invokeVoiceHeartbeat',
    ]) wsCalls[name] = vi.fn();

    // The hub's own connection state, which the service watches so it can assert itself the moment
    // a dropped socket comes back rather than up to 30 seconds later. A signal, so a test can move
    // it and drive the reconnect path.
    const connectionState = signal(ConnectionState.Connected);

    // Both answer for whichever channel was asked, because a snapshot whose `roomId` does not match
    // the joined channel is correctly ignored - a fixed id here would silently disable the very
    // apply path most of these tests are about.
    const guildVoice = {
        // Join answers with the room's authoritative state, same shape as the snapshot read.
        join: vi.fn((_g: string, channelId: string) => of(emptySnapshot(channelId))),
        leave: vi.fn(() => of(undefined)),
        getSnapshot: vi.fn((_g: string, channelId: string) => of(emptySnapshot(channelId))),
    };
    // Every member the service reads at construction: the subjects it subscribes to and the
    // pass-through signals it aliases as its own fields.
    const rtc = {
        closeAllTracks: vi.fn(async () => undefined),
        subscribeAudio: vi.fn(async () => undefined),
        subscribeVideo: vi.fn(async () => undefined),
        subscribedUserIds: vi.fn(() => [] as string[]),
        cleanupParticipant: vi.fn(),
        handleRemoteTrackClosed: vi.fn(),
        publishedMedia: null as { mediaSessionId: string; audioTrackName: string } | null,
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
            {provide: GuildWebsocketService, useValue: {...ws, ...wsCalls, connectionState}},
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
            // Echoes the key rather than loading real translations, so an assertion names the key
            // the service chose instead of a sentence that could be reworded.
            {provide: TranslateService, useValue: {instant: (key: string) => key}},
            // The real VoiceLimitsService over a stubbed ceiling cache. It is what the degradation
            // tests below are actually about, and its one dependency reaches HTTP and the hub for
            // ladders that a room whose limits ride its own snapshot does not need.
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
        channelId: 'chan-1', userId: 'me', mediaSessionId: 'sess-mine', audioTrackName: 'audio',
    });
    await tick();

    expect(rtc.subscribeAudio).not.toHaveBeenCalled();
});

it('still subscribes when somebody else is announced', async () => {
    const {ws, rtc} = setup();

    ws['guildParticipantJoinedObservable'].next({
        channelId: 'chan-1', userId: 'them', mediaSessionId: 'sess-theirs', audioTrackName: 'audio',
    });
    await tick();

    expect(rtc.subscribeAudio).toHaveBeenCalledWith([
        {userId: 'them', mediaSessionId: 'sess-theirs', trackName: 'audio'},
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

/**
 * A join that did not happen.
 *
 * <p>The joined-state signals used to be written before the request went out, and the catch only
 * logged. A refusal therefore left the sidebar, the status bar and the mute controls all rendering
 * as joined against no media, with no way back except clicking another channel - and an entitlement
 * rejection takes exactly this path, so every degradation would have been invisible underneath
 * it.</p>
 */
describe('a join the server refuses', () => {
    const CHANNEL = {
        id: 'chan-2', guildId: 'guild-1', name: 'General', type: ChannelType.Voice,
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

    /**
     * Switching channels leaves the first one silently, on the understanding that the server moves
     * a participant when their next join lands. It did not land, so the room the user left would
     * otherwise still show them in it with no session behind the row.
     */
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

    /**
     * A degradation is a `200`. The room admitted us and gave less than was asked for, and treating
     * that as a failure would be a denial with extra steps - which is exactly what "degrade, do not
     * deny" exists to avoid.
     */
    it('stays in a room that admitted it on reduced terms, and holds what was reduced', async () => {
        const {service, guildVoice, toast} = setup({inChannel: false});
        guildVoice.join.mockReturnValue(of({
            ...emptySnapshot(CHANNEL.id),
            degradations: [{
                key: 'voice.video_ceiling',
                requested: {kind: 'ladder', rung: '1080p60', rank: 4},
                granted: {kind: 'ladder', rung: '720p30', rank: 2},
                reason: 'guild_plan_limit',
                boundBy: 'guild',
                remedy: 'upgrade_guild',
                actorCanRemedy: false,
                subject: {kind: 'guild', id: 'guild-1'},
            }],
        }));

        const joined = await service.joinChannel(CHANNEL, 'Guild');

        expect(joined).toBe(true);
        expect(service.joinedChannelId()).toBe(CHANNEL.id);
        expect(toast.error).not.toHaveBeenCalled();
        // Not a toast. A ceiling is the state of the room for as long as the call lasts, and four
        // seconds of it was the whole of the explanation a user got for a camera button that no
        // longer worked.
        expect(toast.info).not.toHaveBeenCalled();
        expect(service.limits.notices()).toEqual([expect.objectContaining({
            key: 'voice.video_ceiling',
            messageKey: 'ENTITLEMENT.REASON.GUILD_PLAN_LIMIT',
            surfaceKey: 'VOICE.DEGRADED.QUALITY_CAPPED',
            rung: '720p30',
            // The server said this caller cannot act, so there is a sentence naming who can and
            // no button. Nothing here recomputed that.
            ctaKey: null,
            hintKey: 'ENTITLEMENT.CTA.ASK_OWNER',
        })]);
    });

    /** Absent and empty mean the same thing, and both are the normal case. */
    it('says nothing when nothing was reduced', async () => {
        const {service, toast} = setup({inChannel: false});

        await service.joinChannel(CHANNEL, 'Guild');

        expect(toast.info).not.toHaveBeenCalled();
        expect(service.limits.notices()).toEqual([]);
    });

    /** Nothing one room said about its plan may follow the user into the next one. */
    it('drops the last room\'s limits on leaving', async () => {
        const {service, guildVoice} = setup({inChannel: false});
        guildVoice.join.mockReturnValue(of({
            ...emptySnapshot(CHANNEL.id),
            degradations: [{
                key: 'voice.video_ceiling',
                requested: {kind: 'ladder', rung: '1080p60', rank: 4},
                granted: {kind: 'ladder', rung: 'none', rank: 0},
                reason: 'guild_plan_limit',
                remedy: 'upgrade_guild',
                actorCanRemedy: true,
                subject: {kind: 'guild', id: 'guild-1'},
            }],
        }));

        await service.joinChannel(CHANNEL, 'Guild');
        expect(service.limits.notices()).toHaveLength(1);

        await service.leaveChannel();

        expect(service.limits.notices()).toEqual([]);
        expect(service.videoBlock(false)).toBeNull();
    });

    /** Already being there is a success. Callers gate their follow-up action on this. */
    it('reports true for the channel it is already in', async () => {
        const {service, guildVoice} = setup();

        const joined = await service.joinChannel(
            {...CHANNEL, id: 'chan-1'} as ChannelDto, 'Guild');

        expect(joined).toBe(true);
        expect(guildVoice.join).not.toHaveBeenCalled();
    });
});

/**
 * The bug this whole exercise is for.
 *
 * A viewer who joins a channel where a share is already running never saw it. Present when the share
 * started they get `TrackPublished` and subscribe; arriving afterwards there is no event, and the
 * track name needed to pull it - `screen-{shareId}`, a UUID the publisher generated - existed
 * nowhere the joiner could reach. `shares[].trackNames` in the snapshot is that missing piece.
 */
describe('screen share backfill from the snapshot', () => {
    it('subscribes to a share that was already running when we arrived', async () => {
        const {ws, rtc} = setup();

        ws['voiceSnapshotObservable'].next({
            ...emptySnapshot('chan-1'),
            participants: [publisher('them', {
                isStreaming: true,
                shares: [{shareId: 'abc', trackNames: ['screen-abc'], mediaSessionId: 'cf-screen-them'}],
            })],
        });
        await tick();

        // The share's own session, not `cf-them` - a screen share is published from a second
        // process on a session of its own. See voice-channel.share-session.spec.ts.
        expect(rtc.subscribeVideo).toHaveBeenCalledWith(
            'guild-1', 'chan-1', 'them', 'cf-screen-them', 'screen-abc', 'screen');
    });

    /** A share can carry audio, and the two halves are one share tied by the same id. */
    it('subscribes to both halves of a share with audio', async () => {
        const {ws, rtc} = setup();

        ws['voiceSnapshotObservable'].next({
            ...emptySnapshot('chan-1'),
            participants: [publisher('them', {
                isStreaming: true,
                shares: [{
                    shareId: 'abc',
                    trackNames: ['screen-abc', 'screen-audio-abc'],
                    mediaSessionId: 'cf-screen-them',
                }],
            })],
        });
        await tick();

        expect(rtc.subscribeVideo).toHaveBeenCalledWith(
            'guild-1', 'chan-1', 'them', 'cf-screen-them', 'screen-abc', 'screen');
        expect(rtc.subscribeAudio).toHaveBeenCalledWith([
            {userId: 'them', mediaSessionId: 'cf-screen-them', trackName: 'screen-audio-abc', kind: 'screenAudio'},
        ]);
    });

    /**
     * The shape the server actually sends: `Joined` means a session exists and a microphone track
     * does not, and the handles are withheld to match.
     */
    it('does not subscribe to a participant who has only opened a session', async () => {
        const {ws, rtc} = setup();

        ws['voiceSnapshotObservable'].next({
            ...emptySnapshot('chan-1'),
            participants: [publisher('them', {
                publishState: 'Joined', mediaSessionId: null, audioTrackName: null,
            })],
        });
        await tick();

        expect(rtc.subscribeAudio).not.toHaveBeenCalled();
    });

    /**
     * The same participant with the handles present, which is what a server that stopped withholding
     * them would send. `publishState` is the field that carries the meaning; the nulls above are how
     * today's server enforces it, and a client that keyed only on them would subscribe to a track
     * that does not exist yet and burn its retry budget on someone about to be announced properly.
     *
     * <p>Written this way deliberately: with the fixture above alone, removing the `publishState`
     * check entirely leaves every test in this file passing.</p>
     */
    it('does not subscribe on a session id alone, even if the handles are present', async () => {
        const {ws, rtc} = setup();

        ws['voiceSnapshotObservable'].next({
            ...emptySnapshot('chan-1'),
            participants: [publisher('them', {publishState: 'Joined'})],
        });
        await tick();

        expect(rtc.subscribeAudio).not.toHaveBeenCalled();
    });

    /** Our own session cannot pull its own local track - Cloudflare refuses, on every retry. */
    it('does not subscribe to ourselves', async () => {
        const {ws, rtc} = setup();

        ws['voiceSnapshotObservable'].next({
            ...emptySnapshot('chan-1'),
            participants: [publisher('me', {
                isStreaming: true,
                shares: [{shareId: 'mine', trackNames: ['screen-mine'], mediaSessionId: 'cf-screen-mine'}],
            })],
        });
        await tick();

        expect(rtc.subscribeAudio).not.toHaveBeenCalled();
        expect(rtc.subscribeVideo).not.toHaveBeenCalled();
    });

    it('drops anyone the snapshot says is no longer here', async () => {
        const {ws, rtc} = setup();
        rtc.subscribedUserIds.mockReturnValue(['gone', 'them']);

        ws['voiceSnapshotObservable'].next({
            ...emptySnapshot('chan-1'),
            participants: [publisher('them')],
        });
        await tick();

        expect(rtc.cleanupParticipant).toHaveBeenCalledWith('gone');
        expect(rtc.cleanupParticipant).not.toHaveBeenCalledWith('them');
    });

    /**
     * Join answers with the room's authoritative state, so there is no second shape and no second
     * code path - the same snapshot the SignalR event carries, through the same apply. Before the
     * unification this response deliberately withheld the media handles, which is what made HTTP
     * catch-up structurally incapable of restoring a subscription.
     */
    it('subscribes from the snapshot the join call returns', async () => {
        const {service, guildVoice, rtc} = setup({inChannel: false});
        guildVoice.join.mockReturnValue(of({
            ...emptySnapshot('chan-1'),
            participants: [publisher('them', {
                isStreaming: true,
                shares: [{shareId: 'abc', trackNames: ['screen-abc'], mediaSessionId: 'cf-screen-them'}],
            })],
        }));

        await service.joinChannel(
            {id: 'chan-1', guildId: 'guild-1', name: 'General', type: ChannelType.Voice} as ChannelDto,
            'Guild',
        );

        expect(rtc.subscribeVideo).toHaveBeenCalledWith(
            'guild-1', 'chan-1', 'them', 'cf-screen-them', 'screen-abc', 'screen');
    });

    /**
     * A room the local user is not rendered in reads as "the join failed".
     *
     * <p>Asserted after a full join, which applies *two* snapshots - the one join returns and the
     * one refetched once the transport is up. The roster is replaced wholesale by each, so the
     * second erasing us is exactly as bad as the first never adding us.</p>
     */
    it('keeps us in the roster across every snapshot, not just the join one', async () => {
        const {service, guildVoice} = setup({inChannel: false});
        guildVoice.join.mockReturnValue(of(emptySnapshot('chan-1')));
        guildVoice.getSnapshot.mockReturnValue(of(emptySnapshot('chan-1')));

        await service.joinChannel(
            {id: 'chan-1', guildId: 'guild-1', name: 'General', type: ChannelType.Voice} as ChannelDto,
            'Guild',
        );
        await tick();

        expect(service.channelParticipants().get('chan-1')?.some(p => p.isLocal)).toBe(true);
    });

    it('ignores a snapshot for a channel we are not in', async () => {
        const {ws, rtc} = setup();

        ws['voiceSnapshotObservable'].next({
            ...emptySnapshot('other-chan'),
            participants: [publisher('them')],
        });
        await tick();

        expect(rtc.subscribeAudio).not.toHaveBeenCalled();
    });
});

describe('version recovery', () => {
    /** One dropped event used to be permanent. It is now one refetch. */
    it('refetches the snapshot when an event arrives with a gap in the version', async () => {
        const {ws, guildVoice} = setup();

        ws['voiceSnapshotObservable'].next(emptySnapshot('chan-1'));
        await tick();
        guildVoice.getSnapshot.mockClear();

        ws['voiceMuteChangedObservable'].next({
            channelId: 'chan-1', userId: 'them', isMuted: true, serverForced: false,
            instanceId: 'inst-1', version: 4,
        });
        await tick();

        expect(guildVoice.getSnapshot).toHaveBeenCalledWith('guild-1', 'chan-1');
    });

    it('applies an event that is exactly the next one without refetching', async () => {
        const {ws, guildVoice} = setup();

        ws['voiceSnapshotObservable'].next(emptySnapshot('chan-1'));
        await tick();
        guildVoice.getSnapshot.mockClear();

        ws['guildParticipantJoinedObservable'].next({
            channelId: 'chan-1', userId: 'them', mediaSessionId: 'cf-them', audioTrackName: 'audio',
            instanceId: 'inst-1', version: 2,
        });
        await tick();

        expect(guildVoice.getSnapshot).not.toHaveBeenCalled();
    });

    /**
     * A rebuilt room climbs from zero and reaches numbers already seen behind a different roster, so
     * the version alone reads as perfectly in sequence.
     */
    it('refetches when the room was rebuilt under us', async () => {
        const {ws, guildVoice} = setup();

        ws['voiceSnapshotObservable'].next(emptySnapshot('chan-1'));
        await tick();
        guildVoice.getSnapshot.mockClear();

        ws['voiceMuteChangedObservable'].next({
            channelId: 'chan-1', userId: 'them', isMuted: true, serverForced: false,
            instanceId: 'inst-2', version: 2,
        });
        await tick();

        expect(guildVoice.getSnapshot).toHaveBeenCalled();
    });

    /**
     * Not "silently rejoin": re-admitting ourselves on our own say-so is exactly what the server
     * refuses to do, because it would readmit anyone kicked, banned or denied Connect.
     */
    it('leaves the channel locally when the room is gone', async () => {
        const {service, ws, rtc, toast} = setup();

        ws['voiceResyncObservable'].next({channelId: 'chan-1', reason: 'roomGone'});
        await tick();

        expect(rtc.teardown).toHaveBeenCalled();
        expect(service.joinedChannelId()).toBeNull();
        expect(toast.info).toHaveBeenCalledWith('Voice channel is no longer available');
    });

    it('refetches rather than leaving on every other resync reason', async () => {
        const {service, ws, guildVoice} = setup();

        ws['voiceResyncObservable'].next({channelId: 'chan-1', reason: 'participantLeft', userId: 'them'});
        await tick();

        expect(guildVoice.getSnapshot).toHaveBeenCalled();
        expect(service.joinedChannelId()).toBe('chan-1');
    });
});

/**
 * Incident VNT-GE21R3P7. A stale roster is the server's problem to stop producing; acting on it
 * without retrying is ours. The refusal is not an error to back off from - the track is gone, not
 * late - so the only useful response is to read the room again.
 */
describe('a subscribe the server refuses as stale', () => {
    it('refetches the snapshot', async () => {
        const {ws, rtc, guildVoice} = setup();

        ws['voiceSnapshotObservable'].next(emptySnapshot('chan-1'));
        await tick();
        guildVoice.getSnapshot.mockClear();

        rtc.staleSubscription$.next({userId: 'them'});
        await tick();

        expect(guildVoice.getSnapshot).toHaveBeenCalledWith('guild-1', 'chan-1');
    });

    /** Several refusals in a row are one stale roster, and cost one read. */
    it('does not read the room once per refusal', async () => {
        const {ws, rtc, guildVoice} = setup();

        ws['voiceSnapshotObservable'].next(emptySnapshot('chan-1'));
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
    /**
     * The old heartbeat took no arguments, so the server could learn this client was alive but never
     * that it was wrong. Asserting the version is what makes the repair channel work at all.
     */
    it('asserts the tracked version and the session we actually publish on', async () => {
        const {ws, rtc, wsCalls, service} = setup();
        rtc.publishedMedia = {mediaSessionId: 'cf-rust', audioTrackName: 'audio'};

        ws['voiceSnapshotObservable'].next({...emptySnapshot('chan-1'), version: 7});
        await tick();
        (service as unknown as { sendHeartbeat(id: string): void }).sendHeartbeat('chan-1');

        expect(wsCalls['invokeVoiceHeartbeat']).toHaveBeenCalledWith('chan-1', {
            knownInstanceId: 'inst-1', knownVersion: 7,
            mediaSessionId: 'cf-rust', audioTrackName: 'audio',
        });
    });

    /** Honest nulls: the server corrects its record from them and tells peers to drop us. */
    it('reports null handles when not publishing', () => {
        const {wsCalls, service} = setup();

        (service as unknown as { sendHeartbeat(id: string): void }).sendHeartbeat('chan-1');

        expect(wsCalls['invokeVoiceHeartbeat']).toHaveBeenCalledWith('chan-1', {
            knownInstanceId: null, knownVersion: 0, mediaSessionId: null, audioTrackName: null,
        });
    });
});


/**
 * What a hub reconnect means, and - just as important - what it does not.
 *
 * A dropped socket is not a departure: the server shortens this client's liveness window rather
 * than evicting it, and reconnecting restores it. So the client must assert itself immediately
 * instead of waiting up to 30 seconds for the next timer tick, and must leave the media alone -
 * media rides its own transport, and rebuilding the peer connection on a websocket blip spends the
 * media session id and earns `sessionGone` on every call after it.
 */
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

/**
 * A resolution change rebuilds the encoder, which means a new Cloudflare session and a new share
 * id. The old one is dead the moment the rebuild starts, and the room only learns that from the
 * `ScreenShareStopped` sent here - there is no other path. Losing it leaves the share on the
 * server's roster with no session behind it, and every viewer then pulls a track the SFU has
 * already dropped.
 */
describe('a screen share rebuilt at a new resolution', () => {
    const preset = {resolution: '1440p', framerate: 30} as const;

    it('announces the swap when the rebuild works', async () => {
        const {service, rtc, wsCalls} = setup();
        rtc.setScreenPreset.mockResolvedValue({oldShareId: 'old', newShareId: 'new'});

        await service.setScreenPreset(preset);

        expect(wsCalls['invokeVoiceScreenShareStopped']).toHaveBeenCalledWith('chan-1', 'old');
        expect(wsCalls['invokeVoiceScreenShareStarted']).toHaveBeenCalledWith('chan-1', 'new');
    });

    it('still announces the stop when the rebuild fails', async () => {
        // The failing case is not exotic: the rebuild constructs an encoder at a resolution the
        // hardware may refuse, which is exactly when this path is taken.
        const {service, rtc, wsCalls} = setup();
        rtc.setScreenPreset.mockResolvedValue({oldShareId: 'old', newShareId: null});

        await service.setScreenPreset(preset);

        expect(wsCalls['invokeVoiceScreenShareStopped']).toHaveBeenCalledWith('chan-1', 'old');
    });

    it('does not announce a start for a publish that never happened', async () => {
        const {service, rtc, wsCalls} = setup();
        rtc.setScreenPreset.mockResolvedValue({oldShareId: 'old', newShareId: null});

        await service.setScreenPreset(preset);

        expect(wsCalls['invokeVoiceScreenShareStarted']).not.toHaveBeenCalled();
    });

    it('announces nothing when only the framerate changed', async () => {
        // Framerate is applied in place, so there is no swap and nothing to tell the room.
        const {service, rtc, wsCalls} = setup();
        rtc.setScreenPreset.mockResolvedValue(null);

        await service.setScreenPreset(preset);

        expect(wsCalls['invokeVoiceScreenShareStopped']).not.toHaveBeenCalled();
        expect(wsCalls['invokeVoiceScreenShareStarted']).not.toHaveBeenCalled();
    });
});

/**
 * The pre-flight, which is the point of the room carrying its limits at all.
 *
 * <p>The controls disable themselves from the same answer, so this is the second of two checks
 * rather than the only one - and it is the one that covers a hotkey, a stale render and the moment
 * between a ceiling arriving and the next paint. What it must never do is spend a `getUserMedia`
 * prompt or open a source picker for a publish the server has already said no to.</p>
 */
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
        // The picker never opens either. A source dialog for a publish that cannot happen is worse
        // than no button: the user chooses a window and then nothing appears.
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

    /**
     * The one acknowledgement that is genuinely transient. The card explaining it is filed too, so
     * this is "that button did nothing" rather than the whole explanation - and it is never the
     * generic failure sentence, which cannot tell a refused publish from a dead camera.
     */
    it('acknowledges a refusal that beat the pre-flight, by name', async () => {
        const {service, toast} = setup();

        service.limits.noteDenial(new HttpErrorResponse({
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
        }));

        expect(toast.error).toHaveBeenCalledWith('ENTITLEMENT.REASON.GUILD_PLAN_LIMIT');
        expect(service.limits.notices()).toHaveLength(1);
    });
});
