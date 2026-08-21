/**
 * Bug this fixes: a voice roster rendered raw user ids after a cold start and never repaired
 * itself.
 *
 * <p>Every roster entry took its `displayName` from the profile cache at the moment the entry was
 * built. On a launch into a guild where somebody is already in voice - or into our own seat that
 * survived a force quit - the roster is built before any profile has been fetched, so the cache
 * misses and the id wins. Nothing asked for the missing profiles, and nothing rewrote the name once
 * one arrived, so the id stayed on screen for the rest of the session.</p>
 */
import {TestBed} from '@angular/core/testing';
import {TranslateService} from '@ngx-translate/core';
import {of, Subject} from 'rxjs';
import {signal} from '@angular/core';
import {VoiceChannelService} from './voice-channel.service';
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
import {VoiceParticipantSnapshot, VoiceRoomSnapshot} from '../models/voice-room';

interface CachedProfile {
    userName: string;
    avatarUrl?: string;
}

function publisher(userId: string, over: Partial<VoiceParticipantSnapshot> = {}): VoiceParticipantSnapshot {
    return {
        userId,
        mediaSessionId: `sess-${userId}`,
        audioTrackName: 'audio',
        publishState: 'Publishing',
        isSelfMuted: false,
        isSelfDeafened: false,
        isServerMuted: false,
        isServerDeafened: false,
        isStreaming: false,
        shares: [],
        joinedAt: '2026-08-16T12:00:00Z',
        ...over,
    };
}

function snapshot(roomId: string, participants: VoiceParticipantSnapshot[]): VoiceRoomSnapshot {
    return {roomId, kind: 'channel', guildId: 'guild-1', instanceId: 'inst-1', version: 1, participants};
}

const VOICE_CHANNEL = {
    id: 'chan-1',
    guildId: 'guild-1',
    name: 'General',
    type: ChannelType.Voice,
} as ChannelDto;

function setup(options: {inChannel?: boolean; ownProfileLoaded?: boolean} = {}) {
    const ws = new FakeRealtimeConnection();

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

    // The profile cache as a signal, so a test can land a profile *after* the roster was built -
    // which is the whole shape of this bug.
    const profiles = signal<Record<string, CachedProfile>>({});
    const resolveByUserId = vi.fn();
    const ownProfile = signal<{userId: string; userName?: string} | undefined>(
        options.ownProfileLoaded === false ? undefined : {userId: 'me'},
    );

    const guildVoice = {
        join: vi.fn((_g: string, channelId: string) => of(snapshot(channelId, []))),
        leave: vi.fn(() => of(undefined)),
        getSnapshot: vi.fn((_g: string, channelId: string) => of(snapshot(channelId, []))),
    };
    const rtc = {
        closeAllTracks: vi.fn(async () => undefined),
        subscribeAudio: vi.fn(async () => undefined),
        subscribeVideo: vi.fn(async () => undefined),
        subscribedUserIds: vi.fn(() => [] as string[]),
        cleanupParticipant: vi.fn(),
        handleRemoteTrackClosed: vi.fn(),
        publishedMedia: null,
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
    };

    TestBed.configureTestingModule({
        providers: [
            {
                provide: GuildWebsocketService,
                useValue: {...wsCalls, connectionState: signal(ConnectionState.Connected)},
            },
            {provide: RealtimeConnectionService, useValue: ws},
            {provide: GuildVoiceService, useValue: guildVoice},
            {provide: VoiceRTCService, useValue: rtc},
            {
                provide: ProfileService,
                useValue: {
                    ownProfile,
                    getCachedByUserId: (id: string) => profiles()[id],
                    resolveByUserId,
                },
            },
            {provide: SoundSettingsService, useValue: {playVoiceJoin: vi.fn(), playVoiceLeave: vi.fn()}},
            {
                provide: VoiceEngineService,
                useValue: {speaking: () => false, remoteLevels: () => new Map(), setMute: vi.fn()},
            },
            {
                provide: ToastService,
                useValue: {info: vi.fn(), success: vi.fn(), error: vi.fn(), httpError: vi.fn()},
            },
            {provide: TranslateService, useValue: {instant: (key: string) => key}},
            {provide: EntitlementStore, useValue: {ladder: () => undefined, ensureLoaded: () => void 0}},
        ],
    });

    const service = TestBed.inject(VoiceChannelService);
    if (options.inChannel) {
        service.joinedChannelId.set('chan-1');
        service.joinedGuildId.set('guild-1');
    }
    return {service, ws, guildVoice, rtc, profiles, ownProfile, resolveByUserId};
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));

function names(service: VoiceChannelService, channelId = 'chan-1'): string[] {
    return (service.channelParticipants().get(channelId) ?? []).map(p => p.displayName);
}

function loadSidebar(participants: VoiceParticipantSnapshot[], options: {ownProfileLoaded?: boolean} = {}) {
    const harness = setup({inChannel: false, ...options});
    harness.guildVoice.getSnapshot.mockReturnValue(of(snapshot('chan-1', participants)));
    harness.service.loadVoiceStatesForGuild([VOICE_CHANNEL], 'guild-1');
    return harness;
}

/** The sidebar roster for a channel this user is not in - the launch case in the bug report. */
describe('sidebar roster names', () => {
    it('asks for the profile of everyone in the roster it cannot name', () => {
        const {resolveByUserId} = loadSidebar([publisher('user_ada'), publisher('user_bob')]);

        expect(resolveByUserId).toHaveBeenCalledWith('user_ada');
        expect(resolveByUserId).toHaveBeenCalledWith('user_bob');
    });

    it('falls back to the id only while the profile is genuinely unknown', () => {
        const {service} = loadSidebar([publisher('user_ada')]);

        expect(names(service)).toEqual(['user_ada']);
    });

    it('renders the name as soon as the profile lands, without a second roster event', () => {
        const {service, profiles} = loadSidebar([publisher('user_ada')]);

        profiles.set({user_ada: {userName: 'Ada', avatarUrl: 'https://cdn/ada.png'}});

        expect(names(service)).toEqual(['Ada']);
        const ada = service.channelParticipants().get('chan-1')![0];
        expect(ada.avatarLabel).toBe('A');
        expect(ada.avatarUrl).toBe('https://cdn/ada.png');
    });

    /**
     * The roster is read by computeds all over the sidebar and the call stage. A profile landing for
     * one user must not hand every other row a new object, or a rename anywhere repaints everything.
     */
    it('keeps the roster referentially stable when nothing it reads has changed', () => {
        const {service, profiles} = loadSidebar([publisher('user_ada'), publisher('user_bob')]);
        profiles.set({user_ada: {userName: 'Ada'}, user_bob: {userName: 'Bob'}});

        const first = service.channelParticipants();
        const firstBob = first.get('chan-1')![1];

        profiles.update(p => ({...p, user_ada: {userName: 'Ada Lovelace'}}));
        const second = service.channelParticipants();

        expect(second).not.toBe(first);
        expect(second.get('chan-1')![0].displayName).toBe('Ada Lovelace');
        // Bob's row was not touched, so it is the same object it was before.
        expect(second.get('chan-1')![1]).toBe(firstBob);
        // And a read that changes nothing hands back exactly what the last one did.
        expect(service.channelParticipants()).toBe(second);
    });
});

/**
 * Our own seat, which outlives a force quit and lands in the sidebar roster before
 * `/profiles/me` has answered - so at build time we are just another id nobody can name.
 */
describe('own stale seat', () => {
    it('names us once our own profile arrives', () => {
        const {service, profiles, ownProfile} = loadSidebar([publisher('me')], {ownProfileLoaded: false});

        expect(names(service)).toEqual(['me']);

        ownProfile.set({userId: 'me', userName: 'Dominic'});
        profiles.set({me: {userName: 'Dominic'}});

        expect(names(service)).toEqual(['Dominic']);
    });
});

/** The live path, for completeness: somebody joins while we are looking at the channel. */
describe('a user who joins while we are watching', () => {
    it('asks for the profile and names them when it lands', async () => {
        const {service, ws, profiles, resolveByUserId} = setup({inChannel: true});

        ws.emit('guild.voice.UserJoinedVoice', {channelId: 'chan-1', guildId: 'guild-1', userId: 'user_ada'});
        await tick();

        expect(resolveByUserId).toHaveBeenCalledWith('user_ada');
        expect(names(service)).toEqual(['user_ada']);

        profiles.set({user_ada: {userName: 'Ada'}});
        expect(names(service)).toEqual(['Ada']);
    });
});
