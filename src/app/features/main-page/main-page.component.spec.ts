import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal, WritableSignal} from '@angular/core';
import {Router} from '@angular/router';
import {OAuthService} from 'angular-oauth2-oidc';
import {of, Subject, throwError} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {MainPageComponent} from './main-page.component';
import {AuthService} from '../../services/auth.service';
import {NavigationService} from './navigation.service';
import {ProfilePopoutService} from '../../services/profile-popout.service';
import {MessagingWebsocketService} from '../../services/messaging-websocket.service';
import {VoiceWebsocketService} from '../../services/voice-websocket.service';
import {GuildWebsocketService} from '../../services/guild-websocket.service';
import {SocialWebsocketService} from '../../services/social-websocket.service';
import {NotificationService} from '../../services/notification.service';
import {HouseholdAlertService} from '../../services/household-alert.service';
import {
    GoLiveNotificationService,
    STREAM_LIVE_ACTION_TYPE,
} from '../../services/go-live-notification.service';
import {CallFocusService} from '../../services/call-focus.service';
import {VoiceChannelService} from '../../services/voice-channel.service';
import {VoiceResumeService} from '../../services/voice-resume.service';
import {ConversationStore} from '../../stores/conversation.store';
import {UserTokenService} from '../../services/user-token.service';
import {UserService} from '../../services/user.service';
import {MlsService} from '../../services/mls.service';
import {MlsSyncService} from '../../services/mls-sync.service';
import {MlsHealthService} from '../../services/mls-health.service';
import {MasterKeyStateService} from '../../services/master-key-state.service';
import {ConversationService} from '../../services/conversation.service';
import {RichPresenceService} from '../../services/rich-presence.service';
import {EmailVerificationService} from '../../services/email-verification.service';
import {AppReadyService} from '../../services/app-ready.service';
import {GuildService} from '../../services/guild.service';
import {MlsJoinRequestService} from '../../services/mls-join-request.service';
import {OnboardingService} from '../../services/onboarding.service';
import {SocialKeyGateService} from '../../services/social-key-gate.service';
import {AccountRegistryService} from '../../services/account-registry.service';
import {AccountSwitchService} from '../../services/account-switch.service';
import {SessionTeardownService} from '../../services/session-teardown.service';
import {ApiConfigService} from '../../services/api-config.service';
import {ProfileService} from '../../services/profile.service';
import {ProfileCacheService} from '../../services/cache/profile-cache.service';
import {FirstRunService} from '../../services/first-run.service';
import {DeviceRegistrationService} from '../../services/device-registration.service';
import {OsInfo} from '../../platform/ports/os-info.port';
import {FakeOsInfo} from '../../platform/testing/fake-os-info';

/**
 * Lets the launch sequence settle before an assertion. Macrotask hops, not `Promise.resolve()`
 * ticks: the chain is deep enough that a fixed tick count silently stops partway through it.
 */
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setTimeout(resolve, 0));
}

/** `features` is the server's comma-separated string, not a set: `'None'` means no modules. */
function guild(id: string, channels: {id: string; name: string}[], features = 'None'): any {
    return {id, name: `guild-${id}`, channels, features};
}

interface Fakes {
    messagingStart: ReturnType<typeof vi.fn>;
    voiceStart: ReturnType<typeof vi.fn>;
    guildStart: ReturnType<typeof vi.fn>;
    socialStart: ReturnType<typeof vi.fn>;
    ensureTokenRegistered: ReturnType<typeof vi.fn>;
    welcome$: Subject<string>;
    mlsCommit$: Subject<{contextId: string; isChannel: boolean; generation: number}>;
    mlsStateChanged$: Subject<{contextId: string; isChannel: boolean; generation: number}>;
    action$: Subject<{actionTypeId: string; extra: Record<string, string>}>;
    oauthEvents$: Subject<{type: string; reason?: unknown}>;
    ensureValidToken: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    richStart: ReturnType<typeof vi.fn>;
    richStop: ReturnType<typeof vi.fn>;
    processPendingWelcomes: ReturnType<typeof vi.fn>;
    syncContext: ReturnType<typeof vi.fn>;
    refreshState: ReturnType<typeof vi.fn>;
    conversations: WritableSignal<any[]>;
    hydrateConversations: ReturnType<typeof vi.fn>;
    forgetConversations: ReturnType<typeof vi.fn>;
    openConversation: ReturnType<typeof vi.fn>;
    selectServer: ReturnType<typeof vi.fn>;
    openChannel: ReturnType<typeof vi.fn>;
    openHouse: ReturnType<typeof vi.fn>;
    eventsPanelGuildId: WritableSignal<string | null>;
    guilds: WritableSignal<any[]>;
    getOwnMember: ReturnType<typeof vi.fn>;
    forgetCachedGuilds: ReturnType<typeof vi.fn>;
    joinedChannelId: WritableSignal<string | null>;
    joinChannel: ReturnType<typeof vi.fn>;
    focusRequest: ReturnType<typeof vi.fn>;
    voiceResumeCheck: ReturnType<typeof vi.fn>;
    getSelf: ReturnType<typeof vi.fn>;
    self: WritableSignal<any>;
    replenishKeyCount: ReturnType<typeof vi.fn>;
    deviceId: ReturnType<typeof vi.fn>;
    initStorage: ReturnType<typeof vi.fn>;
    autoUnlock: ReturnType<typeof vi.fn>;
    takeovers$: Subject<void>;
    masterKeyRefresh: ReturnType<typeof vi.fn>;
    showEmailVerification: ReturnType<typeof vi.fn>;
    storeKnownEmail: ReturnType<typeof vi.fn>;
    knownEmail: WritableSignal<string>;
    markReady: ReturnType<typeof vi.fn>;
    hydrate: ReturnType<typeof vi.fn>;
    revalidateAll: ReturnType<typeof vi.fn>;
    activeSlot: ReturnType<typeof vi.fn>;
    updateProfile: ReturnType<typeof vi.fn>;
    adoptSignedInAccount: ReturnType<typeof vi.fn>;
    wipeAccount: ReturnType<typeof vi.fn>;
    wipeEngineState: ReturnType<typeof vi.fn>;
    mlsHealthClear: ReturnType<typeof vi.fn>;
    recordFailure: ReturnType<typeof vi.fn>;
    needsOnboarding: ReturnType<typeof vi.fn>;
    wantsSocial: ReturnType<typeof vi.fn>;
    promptNow: ReturnType<typeof vi.fn>;
    getConversations: ReturnType<typeof vi.fn>;
    sweepForAdmission: ReturnType<typeof vi.fn>;
    navigate: ReturnType<typeof vi.fn>;
    getIdentityClaims: ReturnType<typeof vi.fn>;
    registerDevice: ReturnType<typeof vi.fn>;
    firstRunOpen: ReturnType<typeof vi.fn>;
}

function makeFakes(): Fakes {
    return {
        messagingStart: vi.fn().mockResolvedValue(undefined),
        voiceStart: vi.fn().mockResolvedValue(undefined),
        guildStart: vi.fn().mockResolvedValue(undefined),
        socialStart: vi.fn().mockResolvedValue(undefined),
        ensureTokenRegistered: vi.fn().mockResolvedValue(undefined),
        welcome$: new Subject<string>(),
        mlsCommit$: new Subject(),
        mlsStateChanged$: new Subject(),
        action$: new Subject(),
        oauthEvents$: new Subject(),
        ensureValidToken: vi.fn().mockResolvedValue(undefined),
        logout: vi.fn().mockResolvedValue(undefined),
        richStart: vi.fn(),
        richStop: vi.fn(),
        processPendingWelcomes: vi.fn().mockResolvedValue(undefined),
        syncContext: vi.fn().mockResolvedValue(undefined),
        refreshState: vi.fn().mockResolvedValue(undefined),
        conversations: signal<any[]>([]),
        hydrateConversations: vi.fn(async () => 0),
        forgetConversations: vi.fn(),
        openConversation: vi.fn(),
        selectServer: vi.fn(),
        openChannel: vi.fn(),
        openHouse: vi.fn(),
        eventsPanelGuildId: signal<string | null>(null),
        guilds: signal<any[]>([]),
        getOwnMember: vi.fn().mockReturnValue(of({roles: [], permissions: 0})),
        forgetCachedGuilds: vi.fn(),
        joinedChannelId: signal<string | null>(null),
        joinChannel: vi.fn().mockResolvedValue(true),
        focusRequest: vi.fn(),
        voiceResumeCheck: vi.fn(),
        getSelf: vi.fn().mockReturnValue(of({id: 'user-1', email: 'a@b.c', emailVerifiedAt: '2026-01-01'})),
        self: signal<any>({id: 'user-1', encryptedMasterKey: null}),
        replenishKeyCount: vi.fn().mockReturnValue(of(undefined)),
        deviceId: vi.fn().mockResolvedValue('device-1'),
        initStorage: vi.fn().mockReturnValue(of(true)),
        autoUnlock: vi.fn().mockReturnValue(of('handle-1')),
        takeovers$: new Subject<void>(),
        masterKeyRefresh: vi.fn().mockResolvedValue('ok'),
        showEmailVerification: vi.fn(),
        storeKnownEmail: vi.fn(),
        knownEmail: signal(''),
        markReady: vi.fn(),
        hydrate: vi.fn().mockResolvedValue(0),
        revalidateAll: vi.fn(),
        activeSlot: vi.fn().mockResolvedValue({id: 'slot-1', userId: 'user-1'}),
        updateProfile: vi.fn().mockResolvedValue(undefined),
        adoptSignedInAccount: vi.fn().mockResolvedValue({id: 'slot-1', userId: 'user-1'}),
        wipeAccount: vi.fn().mockResolvedValue(undefined),
        wipeEngineState: vi.fn().mockResolvedValue({keyPackagesReset: true}),
        mlsHealthClear: vi.fn(),
        recordFailure: vi.fn(),
        needsOnboarding: vi.fn().mockReturnValue(false),
        wantsSocial: vi.fn().mockReturnValue(false),
        promptNow: vi.fn(),
        getConversations: vi.fn().mockReturnValue(of([])),
        sweepForAdmission: vi.fn().mockResolvedValue({probed: 0, requested: 0}),
        navigate: vi.fn().mockResolvedValue(true),
        getIdentityClaims: vi.fn().mockReturnValue({email: 'claim@b.c'}),
        registerDevice: vi.fn().mockReturnValue(of('handle-new')),
        firstRunOpen: vi.fn().mockResolvedValue(undefined),
    };
}

function configure(fakes: Fakes): void {
    TestBed.configureTestingModule({
        imports: [MainPageComponent],
        providers: [
            {
                provide: AuthService,
                useValue: {ensureValidToken: fakes.ensureValidToken, logout: fakes.logout},
            },
            {
                provide: OAuthService,
                useValue: {events: fakes.oauthEvents$, getIdentityClaims: fakes.getIdentityClaims},
            },
            {provide: Router, useValue: {navigate: fakes.navigate}},
            {
                provide: NavigationService,
                useValue: {
                    workspace: signal({type: 'dms'}),
                    mainView: signal({type: 'home'}),
                    mobileNavOpen: signal(false),
                    mobileSection: signal('conversations'),
                    eventsPanelGuildId: fakes.eventsPanelGuildId,
                    openConversation: fakes.openConversation,
                    selectServer: fakes.selectServer,
                    openChannel: fakes.openChannel,
                    openHouse: fakes.openHouse,
                    showHome: vi.fn(),
                },
            },
            {provide: ProfilePopoutService, useValue: {selectedUserId: signal(null), close: vi.fn()}},
            {
                provide: MessagingWebsocketService,
                useValue: {
                    start: fakes.messagingStart,
                    welcomeObservable: fakes.welcome$,
                    mlsCommitObservable: fakes.mlsCommit$,
                    mlsStateChangedObservable: fakes.mlsStateChanged$,
                },
            },
            {provide: VoiceWebsocketService, useValue: {start: fakes.voiceStart}},
            {provide: GuildWebsocketService, useValue: {start: fakes.guildStart}},
            {provide: SocialWebsocketService, useValue: {start: fakes.socialStart}},
            {provide: NotificationService, useValue: {action$: fakes.action$}},
            {provide: HouseholdAlertService, useValue: {}},
            {provide: GoLiveNotificationService, useValue: {}},
            {provide: CallFocusService, useValue: {request: fakes.focusRequest}},
            {
                provide: VoiceChannelService,
                useValue: {joinedChannelId: fakes.joinedChannelId, joinChannel: fakes.joinChannel},
            },
            {provide: VoiceResumeService, useValue: {check: fakes.voiceResumeCheck}},
            {
                provide: ConversationStore,
                useValue: {
                    entities: fakes.conversations,
                    hydrate: fakes.hydrateConversations,
                    forget: fakes.forgetConversations,
                },
            },
            {provide: UserTokenService, useValue: {ensureTokenRegistered: fakes.ensureTokenRegistered}},
            {
                provide: UserService,
                useValue: {
                    getSelf: fakes.getSelf,
                    self: fakes.self,
                    replenishKeyCount: fakes.replenishKeyCount,
                },
            },
            {
                provide: MlsService,
                useValue: {
                    getOrCreateDeviceIdentifier: fakes.deviceId,
                    initStorage: fakes.initStorage,
                    autoUnlock: fakes.autoUnlock,
                    sessionTakeovers: () => fakes.takeovers$,
                },
            },
            {
                provide: MlsSyncService,
                useValue: {
                    processPendingWelcomes: fakes.processPendingWelcomes,
                    syncContext: fakes.syncContext,
                    refreshState: fakes.refreshState,
                },
            },
            {
                provide: MlsHealthService,
                useValue: {clear: fakes.mlsHealthClear, recordFailure: fakes.recordFailure},
            },
            {provide: MasterKeyStateService, useValue: {refresh: fakes.masterKeyRefresh}},
            {provide: ConversationService, useValue: {getConversations: fakes.getConversations}},
            {provide: RichPresenceService, useValue: {start: fakes.richStart, stop: fakes.richStop}},
            {
                provide: EmailVerificationService,
                useValue: {
                    show: fakes.showEmailVerification,
                    storeKnownEmail: fakes.storeKnownEmail,
                    knownEmail: fakes.knownEmail,
                },
            },
            {provide: AppReadyService, useValue: {markReady: fakes.markReady, ready: signal(false)}},
            {
                provide: GuildService,
                useValue: {
                    guilds: fakes.guilds,
                    getOwnMember: fakes.getOwnMember,
                    forgetCachedGuilds: fakes.forgetCachedGuilds,
                },
            },
            {provide: MlsJoinRequestService, useValue: {sweepForAdmission: fakes.sweepForAdmission}},
            {
                provide: OnboardingService,
                useValue: {
                    needsOnboarding: fakes.needsOnboarding,
                    wantsSocial: fakes.wantsSocial,
                },
            },
            {
                provide: SocialKeyGateService,
                useValue: {
                    promptNow: fakes.promptNow,
                    dismissible: signal(true),
                    dialogVisible: signal(false),
                    onDismissed: vi.fn(),
                    onSetupComplete: vi.fn(),
                },
            },
            {
                provide: AccountRegistryService,
                useValue: {activeSlot: fakes.activeSlot, updateProfile: fakes.updateProfile},
            },
            {provide: AccountSwitchService, useValue: {adoptSignedInAccount: fakes.adoptSignedInAccount}},
            {
                provide: SessionTeardownService,
                useValue: {wipeAccount: fakes.wipeAccount, wipeEngineState: fakes.wipeEngineState},
            },
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test'}},
            {provide: ProfileService, useValue: {getSelf: () => of({userName: 'me', avatarUrl: null})}},
            {
                provide: ProfileCacheService,
                useValue: {hydrate: fakes.hydrate, revalidateAll: fakes.revalidateAll},
            },
            {provide: FirstRunService, useValue: {open: fakes.firstRunOpen}},
            {provide: DeviceRegistrationService, useValue: {register: fakes.registerDevice}},
            {provide: OsInfo, useValue: new FakeOsInfo()},
        ],
    });

    // The child components are irrelevant to the orchestration under test and each drags in its
    // own dependency graph.
    TestBed.overrideComponent(MainPageComponent, {set: {template: '', imports: []}});
}

async function setup(fakes: Fakes = makeFakes()): Promise<{
    fixture: ComponentFixture<MainPageComponent>;
    component: any;
    fakes: Fakes;
}> {
    configure(fakes);
    const fixture = TestBed.createComponent(MainPageComponent);
    fixture.detectChanges();
    await settle();
    return {fixture, component: fixture.componentInstance as any, fakes};
}

describe('MainPageComponent construction', () => {
    beforeEach(() => TestBed.resetTestingModule());
    afterEach(() => vi.restoreAllMocks());

    it('starts all four websockets and registers the push token', async () => {
        const {fakes} = await setup();

        expect(fakes.messagingStart).toHaveBeenCalled();
        expect(fakes.voiceStart).toHaveBeenCalled();
        expect(fakes.guildStart).toHaveBeenCalled();
        expect(fakes.socialStart).toHaveBeenCalled();
        expect(fakes.ensureTokenRegistered).toHaveBeenCalled();
    });

    it('starts rich presence, and stops it on destroy', async () => {
        const {fixture, fakes} = await setup();
        expect(fakes.richStart).toHaveBeenCalled();

        fixture.destroy();
        expect(fakes.richStop).toHaveBeenCalled();
    });

    it('drops every subscription on destroy', async () => {
        const {fixture, fakes} = await setup();
        // The launch takes pending Welcomes itself, so only post-destroy calls are evidence here.
        fakes.processPendingWelcomes.mockClear();
        fakes.conversations.set([{id: 'conv-1'}]);
        fixture.destroy();

        fakes.action$.next({actionTypeId: 'x', extra: {conversationId: 'conv-1'}});
        fakes.welcome$.next('conv-1');
        expect(fakes.openConversation).not.toHaveBeenCalled();
        expect(fakes.processPendingWelcomes).not.toHaveBeenCalled();
    });
});

describe('MainPageComponent notification routing', () => {
    beforeEach(() => TestBed.resetTestingModule());
    afterEach(() => vi.restoreAllMocks());

    it('opens the conversation named by a notification', async () => {
        const {fakes} = await setup();
        const conv = {id: 'conv-1'};
        fakes.conversations.set([conv]);

        fakes.action$.next({actionTypeId: 'a', extra: {conversationId: 'conv-1'}});

        expect(fakes.openConversation).toHaveBeenCalledWith(conv);
    });

    it('ignores a conversation id that resolves to nothing, and does not fall through', async () => {
        const {fakes} = await setup();

        fakes.action$.next({actionTypeId: 'a', extra: {conversationId: 'gone', type: 'household'}});

        expect(fakes.openConversation).not.toHaveBeenCalled();
        expect(fakes.selectServer).not.toHaveBeenCalled();
    });

    it('selects the guild then opens the channel for a household notification', async () => {
        const {fakes} = await setup();
        const g = guild('g1', [{id: 'c1', name: 'chores'}]);
        fakes.guilds.set([g]);

        fakes.action$.next({actionTypeId: 'a', extra: {type: 'household', guildId: 'g1', channelId: 'c1'}});

        expect(fakes.selectServer).toHaveBeenCalledWith(g);
        expect(fakes.openChannel).toHaveBeenCalledWith(g.channels[0]);
        expect(fakes.openHouse).not.toHaveBeenCalled();
    });

    it('falls back to the house when the household channel is unresolvable', async () => {
        const {fakes} = await setup();
        fakes.guilds.set([guild('g1', [], 'Chores')]);

        fakes.action$.next({
            actionTypeId: 'a',
            extra: {type: 'household', guildId: 'g1', channelId: 'missing'},
        });

        expect(fakes.selectServer).toHaveBeenCalled();
        expect(fakes.openChannel).not.toHaveBeenCalled();
        expect(fakes.openHouse).toHaveBeenCalledWith('g1');
    });

    it('does nothing for a household notification naming an unknown guild', async () => {
        const {fakes} = await setup();

        fakes.action$.next({actionTypeId: 'a', extra: {type: 'household', guildId: 'nope'}});

        expect(fakes.selectServer).not.toHaveBeenCalled();
    });

    it('joins voice then arms a focus request for a go-live notification', async () => {
        const {fakes} = await setup();
        const g = guild('g1', [{id: 'c1', name: 'general'}]);
        fakes.guilds.set([g]);

        fakes.action$.next({
            actionTypeId: STREAM_LIVE_ACTION_TYPE,
            extra: {type: STREAM_LIVE_ACTION_TYPE, guildId: 'g1', channelId: 'c1', userId: 'u9'},
        });
        await settle();

        expect(fakes.openChannel).toHaveBeenCalledWith(g.channels[0]);
        expect(fakes.joinChannel).toHaveBeenCalledWith(g.channels[0], g.name);
        expect(fakes.focusRequest).toHaveBeenCalledWith('channel:c1', {userId: 'u9'});
    });

    it('skips the join when already in that voice channel, and still arms the focus', async () => {
        const {fakes} = await setup();
        fakes.guilds.set([guild('g1', [{id: 'c1', name: 'general'}])]);
        fakes.joinedChannelId.set('c1');

        fakes.action$.next({
            actionTypeId: STREAM_LIVE_ACTION_TYPE,
            extra: {type: STREAM_LIVE_ACTION_TYPE, guildId: 'g1', channelId: 'c1', userId: 'u9'},
        });
        await settle();

        expect(fakes.joinChannel).not.toHaveBeenCalled();
        expect(fakes.focusRequest).toHaveBeenCalledWith('channel:c1', {userId: 'u9'});
    });

    it('does not arm a focus request when the voice join is refused', async () => {
        const {fakes} = await setup();
        fakes.guilds.set([guild('g1', [{id: 'c1', name: 'general'}])]);
        fakes.joinChannel.mockResolvedValue(false);

        fakes.action$.next({
            actionTypeId: STREAM_LIVE_ACTION_TYPE,
            extra: {type: STREAM_LIVE_ACTION_TYPE, guildId: 'g1', channelId: 'c1', userId: 'u9'},
        });
        await settle();

        expect(fakes.focusRequest).not.toHaveBeenCalled();
    });
});

describe('MainPageComponent MLS realtime sync', () => {
    beforeEach(() => TestBed.resetTestingModule());
    afterEach(() => vi.restoreAllMocks());

    it('routes a Welcome push to processPendingWelcomes', async () => {
        const {fakes} = await setup();
        fakes.processPendingWelcomes.mockClear();

        fakes.welcome$.next('conv-1');
        await settle();

        expect(fakes.processPendingWelcomes).toHaveBeenCalledTimes(1);
    });

    it('routes a commit push to syncContext with the context and channel flag', async () => {
        const {fakes} = await setup();

        fakes.mlsCommit$.next({contextId: 'ctx-1', isChannel: true, generation: 3});
        await settle();

        expect(fakes.syncContext).toHaveBeenCalledWith('ctx-1', true);
    });

    it('routes a state-changed push to refreshState', async () => {
        const {fakes} = await setup();

        fakes.mlsStateChanged$.next({contextId: 'ctx-2', isChannel: false, generation: 1});
        await settle();

        expect(fakes.refreshState).toHaveBeenCalledWith('ctx-2', false);
    });

    it('keeps the subscriptions alive after a handler rejects', async () => {
        const {fakes} = await setup();
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        fakes.syncContext.mockRejectedValueOnce(new Error('boom'));

        fakes.mlsCommit$.next({contextId: 'ctx-1', isChannel: false, generation: 1});
        await settle();
        expect(err).toHaveBeenCalled();

        fakes.mlsCommit$.next({contextId: 'ctx-2', isChannel: false, generation: 2});
        await settle();
        expect(fakes.syncContext).toHaveBeenCalledWith('ctx-2', false);
    });
});

describe('MainPageComponent launch sequence gates', () => {
    beforeEach(() => TestBed.resetTestingModule());
    afterEach(() => vi.restoreAllMocks());

    it('shows email verification and stops on a 403 from getSelf', async () => {
        const fakes = makeFakes();
        fakes.knownEmail.set('known@b.c');
        fakes.getSelf.mockReturnValue(throwError(() => ({status: 403})));
        await setup(fakes);

        expect(fakes.showEmailVerification).toHaveBeenCalledWith('known@b.c', {action: 'navigate-login'});
        expect(fakes.deviceId).not.toHaveBeenCalled();
        expect(fakes.markReady).toHaveBeenCalled();
    });

    it('falls back to the id-token claims when no email is known', async () => {
        const fakes = makeFakes();
        fakes.getSelf.mockReturnValue(throwError(() => ({status: 403})));
        await setup(fakes);

        expect(fakes.showEmailVerification).toHaveBeenCalledWith('claim@b.c', {action: 'navigate-login'});
    });

    it('continues to the device launch when getSelf fails for any other reason', async () => {
        const fakes = makeFakes();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        fakes.getSelf.mockReturnValue(throwError(() => ({status: 500})));
        await setup(fakes);

        expect(fakes.showEmailVerification).not.toHaveBeenCalled();
        expect(fakes.deviceId).toHaveBeenCalled();
    });

    it('adopts the account slot before any device id is read', async () => {
        const fakes = makeFakes();
        const order: string[] = [];
        fakes.adoptSignedInAccount.mockImplementation(async () => {
            order.push('adopt');
            return {id: 'slot-1', userId: 'user-1'};
        });
        fakes.deviceId.mockImplementation(async () => {
            order.push('device-id');
            return 'device-1';
        });
        await setup(fakes);

        expect(order).toEqual(['adopt', 'device-id']);
        expect(fakes.adoptSignedInAccount).toHaveBeenCalledWith({
            userId: 'user-1',
            serverUrl: 'https://api.test',
        });
    });

    it('stops on an unverified email', async () => {
        const fakes = makeFakes();
        fakes.getSelf.mockReturnValue(of({id: 'user-1', email: 'a@b.c', emailVerifiedAt: null}));
        await setup(fakes);

        expect(fakes.storeKnownEmail).toHaveBeenCalledWith('a@b.c');
        expect(fakes.showEmailVerification).toHaveBeenCalledWith('a@b.c');
        expect(fakes.deviceId).not.toHaveBeenCalled();
    });

    it('stops and hands first run the screen when onboarding is owed', async () => {
        const fakes = makeFakes();
        fakes.needsOnboarding.mockReturnValue(true);
        fakes.firstRunOpen.mockReturnValue(new Promise<void>(() => {}));
        await setup(fakes);

        expect(fakes.firstRunOpen).toHaveBeenCalled();
        expect(fakes.deviceId).not.toHaveBeenCalled();
        // The first-run takeover is opaque, so it reveals without hydrating.
        expect(fakes.markReady).toHaveBeenCalled();
        expect(fakes.hydrate).not.toHaveBeenCalled();
    });

    it('restarts at the device half when first run closes', async () => {
        const fakes = makeFakes();
        let closeFirstRun = (): void => undefined;
        fakes.needsOnboarding.mockReturnValue(true);
        fakes.firstRunOpen.mockReturnValue(new Promise<void>(resolve => (closeFirstRun = resolve)));
        await setup(fakes);
        expect(fakes.deviceId).not.toHaveBeenCalled();

        closeFirstRun();
        await settle();

        expect(fakes.deviceId).toHaveBeenCalled();
        expect(fakes.autoUnlock).toHaveBeenCalled();
        // The account half is not replayed.
        expect(fakes.getSelf).toHaveBeenCalledTimes(1);
    });

    it('reruns the device launch when this tab is handed the engine', async () => {
        const fakes = makeFakes();
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        await setup(fakes);
        expect(fakes.deviceId).toHaveBeenCalledTimes(1);

        fakes.takeovers$.next();
        await settle();

        expect(fakes.deviceId).toHaveBeenCalledTimes(2);
    });
});

describe('MainPageComponent device launch', () => {
    beforeEach(() => TestBed.resetTestingModule());
    afterEach(() => vi.restoreAllMocks());

    it('hydrates the profile cache before the network work, and checks voice resume last', async () => {
        const fakes = makeFakes();
        const order: string[] = [];
        fakes.hydrate.mockImplementation(async () => {
            order.push('hydrate');
            return 2;
        });
        fakes.markReady.mockImplementation(() => order.push('ready'));
        fakes.initStorage.mockImplementation(() => {
            order.push('init-storage');
            return of(true);
        });
        fakes.autoUnlock.mockImplementation(() => {
            order.push('unlock');
            return of('handle-1');
        });
        fakes.voiceResumeCheck.mockImplementation(() => order.push('voice-resume'));
        await setup(fakes);

        expect(order).toEqual(['hydrate', 'ready', 'init-storage', 'unlock', 'voice-resume']);
        expect(fakes.revalidateAll).toHaveBeenCalled();
    });

    it('does not revalidate when nothing was hydrated', async () => {
        const fakes = makeFakes();
        fakes.hydrate.mockResolvedValue(0);
        await setup(fakes);

        expect(fakes.revalidateAll).not.toHaveBeenCalled();
        expect(fakes.markReady).toHaveBeenCalled();
    });

    it('unlocks against the device id and the slot owner', async () => {
        const {fakes} = await setup();
        expect(fakes.autoUnlock).toHaveBeenCalledWith('device-1', 'user-1');
    });

    it('sweeps for admission over the conversations page', async () => {
        const fakes = makeFakes();
        fakes.getConversations.mockReturnValue(
            of([
                {id: 'c1', encryptionState: 'Encrypted'},
                {id: 'c2', encryptionState: 'Plain'},
            ]),
        );
        await setup(fakes);

        expect(fakes.getConversations).toHaveBeenCalledWith(0, 100);
        expect(fakes.sweepForAdmission).toHaveBeenCalledWith([
            {contextId: 'c1', isChannel: false, serverSaysEncrypted: true},
            {contextId: 'c2', isChannel: false, serverSaysEncrypted: false},
        ]);
    });

    it('records the storage banner and does not wipe on a non-wiping storage fault', async () => {
        const fakes = makeFakes();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        fakes.initStorage.mockReturnValue(throwError(() => new Error('locked')));
        const {component} = await setup(fakes);

        expect(component.mlsStorageUnavailable()).toBe(true);
        expect(fakes.wipeEngineState).not.toHaveBeenCalled();
    });

    it('clears the storage banner on a healthy launch', async () => {
        const {component} = await setup();
        expect(component.mlsStorageUnavailable()).toBe(false);
    });

    it('prompts the social key gate for a keyless account that wants social', async () => {
        const fakes = makeFakes();
        fakes.self.set({id: 'user-1', encryptedMasterKey: null});
        fakes.wantsSocial.mockReturnValue(true);
        await setup(fakes);

        expect(fakes.promptNow).toHaveBeenCalled();
        expect(fakes.masterKeyRefresh).not.toHaveBeenCalled();
    });

    it('leaves an Isle-only keyless account alone', async () => {
        const fakes = makeFakes();
        fakes.wantsSocial.mockReturnValue(false);
        await setup(fakes);

        expect(fakes.promptNow).not.toHaveBeenCalled();
    });

    it('offers master-key recovery when the stored key will not open', async () => {
        const fakes = makeFakes();
        fakes.self.set({id: 'user-1', encryptedMasterKey: 'blob'});
        fakes.masterKeyRefresh.mockResolvedValue('needs-recovery');
        const {component} = await setup(fakes);

        expect(component.showMasterKeyRecovery()).toBe(true);
    });

    it('stays quiet when the master key is healthy or not set up', async () => {
        for (const action of ['ok', 'not-set-up']) {
            TestBed.resetTestingModule();
            const fakes = makeFakes();
            fakes.self.set({id: 'user-1', encryptedMasterKey: 'blob'});
            fakes.masterKeyRefresh.mockResolvedValue(action);
            const {component} = await setup(fakes);

            expect(component.showMasterKeyRecovery()).toBe(false);
        }
    });
});

describe('MainPageComponent launch outcome banners', () => {
    beforeEach(() => TestBed.resetTestingModule());
    afterEach(() => vi.restoreAllMocks());

    async function launchWith(kind: string | undefined): Promise<{component: any; fakes: Fakes}> {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const fakes = makeFakes();
        fakes.autoUnlock.mockReturnValue(throwError(() => ({kind})));
        const {component} = await setup(fakes);
        return {component, fakes};
    }

    it('sets the session handle on a clean unlock and registers nothing', async () => {
        const {component, fakes} = await setup();

        expect(component.keyHandle()).toBe('handle-1');
        expect(fakes.registerDevice).not.toHaveBeenCalled();
        expect(component.keyUnlockFailed()).toBe(false);
        expect(component.keyStoreIncomplete()).toBe(false);
        expect(component.keyPackagesFailed()).toBe(false);
    });

    it('registers this device only for KeyNotFound', async () => {
        const {component, fakes} = await launchWith('KeyNotFound');

        expect(fakes.registerDevice).toHaveBeenCalled();
        expect(component.keyUnlockFailed()).toBe(false);
        expect(component.keyStoreIncomplete()).toBe(false);
    });

    it('an unreachable key store fails the unlock without registering', async () => {
        const {component, fakes} = await launchWith('KeyStoreUnreachable');

        expect(fakes.registerDevice).not.toHaveBeenCalled();
        expect(component.keyUnlockFailed()).toBe(true);
        expect(component.keyStoreIncomplete()).toBe(false);
    });

    it('an unrecognised failure kind is treated as unreachable, never as registration', async () => {
        const {component, fakes} = await launchWith(undefined);

        expect(fakes.registerDevice).not.toHaveBeenCalled();
        expect(component.keyUnlockFailed()).toBe(true);
    });

    it('an identity mismatch fails the unlock without registering', async () => {
        const {component, fakes} = await launchWith('IdentityMismatch');

        expect(fakes.registerDevice).not.toHaveBeenCalled();
        expect(component.keyUnlockFailed()).toBe(true);
        expect(component.keyStoreIncomplete()).toBe(false);
    });

    it('a partly present key store sets both flags and registers nothing', async () => {
        const {component, fakes} = await launchWith('KeyStoreIncomplete');

        expect(fakes.registerDevice).not.toHaveBeenCalled();
        expect(component.keyUnlockFailed()).toBe(true);
        expect(component.keyStoreIncomplete()).toBe(true);
    });

    it('raises the key-package banner when the upload failed, on its own', async () => {
        const fakes = makeFakes();
        fakes.replenishKeyCount.mockReturnValue(throwError(() => new Error('nope')));
        const {component} = await setup(fakes);

        expect(component.keyPackagesFailed()).toBe(true);
        expect(component.keyUnlockFailed()).toBe(false);
        expect(fakes.registerDevice).not.toHaveBeenCalled();
    });
});

describe('MainPageComponent retry actions', () => {
    beforeEach(() => TestBed.resetTestingModule());
    afterEach(() => vi.restoreAllMocks());

    it('replenishKeyPackages clears the banner and re-raises it on failure', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const fakes = makeFakes();
        fakes.replenishKeyCount.mockReturnValue(throwError(() => new Error('nope')));
        const {component} = await setup(fakes);
        expect(component.keyPackagesFailed()).toBe(true);

        fakes.replenishKeyCount.mockReturnValue(of(undefined));
        await component.replenishKeyPackages();
        expect(component.keyPackagesFailed()).toBe(false);

        fakes.replenishKeyCount.mockReturnValue(throwError(() => new Error('nope')));
        await component.replenishKeyPackages();
        expect(component.keyPackagesFailed()).toBe(true);
    });

    it('retryUnlock clears both key-store flags and reruns the whole sequence', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const fakes = makeFakes();
        fakes.autoUnlock.mockReturnValue(throwError(() => ({kind: 'KeyStoreIncomplete'})));
        const {component} = await setup(fakes);
        expect(component.keyUnlockFailed()).toBe(true);

        fakes.autoUnlock.mockReturnValue(of('handle-2'));
        await component.retryUnlock();
        await settle();

        expect(fakes.getSelf).toHaveBeenCalledTimes(2);
        expect(component.keyUnlockFailed()).toBe(false);
        expect(component.keyStoreIncomplete()).toBe(false);
        expect(component.keyHandle()).toBe('handle-2');
    });

    it('retryMlsStorage clears the banner and reruns the whole sequence', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const fakes = makeFakes();
        fakes.initStorage.mockReturnValue(throwError(() => new Error('locked')));
        const {component} = await setup(fakes);
        expect(component.mlsStorageUnavailable()).toBe(true);

        fakes.initStorage.mockReturnValue(of(true));
        await component.retryMlsStorage();
        await settle();

        expect(component.mlsStorageUnavailable()).toBe(false);
        expect(fakes.getSelf).toHaveBeenCalledTimes(2);
    });
});

describe('MainPageComponent device registration', () => {
    beforeEach(() => TestBed.resetTestingModule());
    afterEach(() => vi.restoreAllMocks());

    it('a successful registration stores the handle and re-reads the account', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const fakes = makeFakes();
        fakes.autoUnlock.mockReturnValue(throwError(() => ({kind: 'KeyNotFound'})));
        fakes.registerDevice.mockReturnValue(of('handle-new'));
        fakes.self.set({id: 'user-1', encryptedMasterKey: 'blob'});
        fakes.masterKeyRefresh.mockResolvedValue('needs-recovery');
        const {component} = await setup(fakes);

        expect(fakes.registerDevice).toHaveBeenCalled();
        expect(component.keyHandle()).toBe('handle-new');
        // The account gates read it once; the second read is the post-registration one.
        expect(fakes.getSelf).toHaveBeenCalledTimes(2);
        expect(fakes.replenishKeyCount).toHaveBeenCalled();
        expect(component.showMasterKeyRecovery()).toBe(true);
    });

    it('a registration re-read that 403s surfaces email verification', async () => {
        const fakes = makeFakes();
        fakes.knownEmail.set('known@b.c');
        fakes.autoUnlock.mockReturnValue(throwError(() => ({kind: 'KeyNotFound'})));
        fakes.getSelf
            .mockReturnValueOnce(of({id: 'user-1', email: 'a@b.c', emailVerifiedAt: '2026-01-01'}))
            .mockReturnValue(throwError(() => ({status: 403})));
        await setup(fakes);

        expect(fakes.showEmailVerification).toHaveBeenCalledWith('known@b.c', {action: 'navigate-login'});
    });

    it('a failed registration is logged and leaves the unlock outcome flags alone', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const fakes = makeFakes();
        fakes.autoUnlock.mockReturnValue(throwError(() => ({kind: 'KeyNotFound'})));
        fakes.registerDevice.mockReturnValue(throwError(() => new Error('nope')));
        const {component} = await setup(fakes);

        expect(err).toHaveBeenCalled();
        expect(component.deviceRegistrationFailed()).toBe(true);
        expect(component.keyHandle()).toBeNull();
        expect(component.keyUnlockFailed()).toBe(false);
        expect(component.keyStoreIncomplete()).toBe(false);
        expect(component.keyPackagesFailed()).toBe(false);
        expect(fakes.voiceResumeCheck).toHaveBeenCalled();
    });

    it('a failed registration raises the retry strip, and a successful retry clears it', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const fakes = makeFakes();
        fakes.registerDevice.mockReturnValue(throwError(() => new Error('nope')));
        const {component} = await setup(fakes);

        await component.registerThisDevice();
        expect(component.deviceRegistrationFailed()).toBe(true);

        fakes.registerDevice.mockReturnValue(of('handle-new'));
        await component.registerThisDevice();

        expect(component.deviceRegistrationFailed()).toBe(false);
        expect(component.keyHandle()).toBe('handle-new');
    });

    it('two overlapping registrations register once, and both callers resolve', async () => {
        const fakes = makeFakes();
        const inFlight = new Subject<string>();
        fakes.registerDevice.mockReturnValue(inFlight);
        const {component} = await setup(fakes);

        const first = component.registerThisDevice();
        const second = component.registerThisDevice();
        await settle();

        expect(fakes.registerDevice).toHaveBeenCalledTimes(1);

        inFlight.next('handle-new');
        inFlight.complete();
        await Promise.all([first, second]);

        expect(component.keyHandle()).toBe('handle-new');
    });

    it('the guard clears once registration settles, so a later call registers again', async () => {
        const fakes = makeFakes();
        const {component} = await setup(fakes);

        await component.registerThisDevice();
        await component.registerThisDevice();

        expect(fakes.registerDevice).toHaveBeenCalledTimes(2);
    });

    it('a key-package upload that fails after registering raises its own banner', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const fakes = makeFakes();
        const {component} = await setup(fakes);
        fakes.replenishKeyCount.mockReturnValue(throwError(() => new Error('nope')));

        await component.registerThisDevice();

        expect(component.keyPackagesFailed()).toBe(true);
        expect(component.deviceRegistrationFailed()).toBe(false);
    });
});

describe('MainPageComponent token lifecycle', () => {
    beforeEach(() => TestBed.resetTestingModule());
    afterEach(() => vi.restoreAllMocks());

    it('refreshes through ensureValidToken on token_expires', async () => {
        const {fakes} = await setup();

        fakes.oauthEvents$.next({type: 'token_expires'});

        expect(fakes.ensureValidToken).toHaveBeenCalled();
    });

    it('survives a rejected refresh', async () => {
        const {fakes} = await setup();
        fakes.ensureValidToken.mockRejectedValue(new Error('nope'));

        fakes.oauthEvents$.next({type: 'token_expires'});
        await settle();

        fakes.oauthEvents$.next({type: 'token_expires'});
        expect(fakes.ensureValidToken).toHaveBeenCalledTimes(2);
    });

    it('shows email verification on a 403 token_refresh_error', async () => {
        const {fakes} = await setup();
        fakes.knownEmail.set('known@b.c');

        fakes.oauthEvents$.next({type: 'token_refresh_error', reason: {status: 403}});

        expect(fakes.showEmailVerification).toHaveBeenCalledWith('known@b.c', {action: 'navigate-login'});
    });

    it('reads the status out of a nested error too, and only for 403', async () => {
        const {fakes} = await setup();

        fakes.oauthEvents$.next({type: 'silent_refresh_error', reason: {error: {status: 403}}});
        expect(fakes.showEmailVerification).toHaveBeenCalled();

        fakes.showEmailVerification.mockClear();
        fakes.oauthEvents$.next({type: 'token_refresh_error', reason: {status: 500}});
        expect(fakes.showEmailVerification).not.toHaveBeenCalled();
    });
});

describe('MainPageComponent sign out', () => {
    beforeEach(() => TestBed.resetTestingModule());
    afterEach(() => vi.restoreAllMocks());

    it('wipes this device, drops the tokens and navigates to the login route', async () => {
        const {component, fakes} = await setup();

        component.logout();
        await settle();

        expect(fakes.wipeAccount).toHaveBeenCalledWith('device-1');
        expect(fakes.richStop).toHaveBeenCalled();
        expect(fakes.forgetCachedGuilds).toHaveBeenCalled();
        expect(fakes.logout).toHaveBeenCalled();
        expect(fakes.navigate).toHaveBeenCalledWith(['/authentication']);
    });

    it('ctrl+shift+L signs out', async () => {
        const {component, fakes} = await setup();

        component.onKeydown({ctrlKey: true, shiftKey: true, key: 'L'} as KeyboardEvent);
        await settle();

        expect(fakes.navigate).toHaveBeenCalledWith(['/authentication']);
    });

    it('ignores other key combinations', async () => {
        const {component, fakes} = await setup();

        component.onKeydown({ctrlKey: true, shiftKey: false, key: 'l'} as KeyboardEvent);
        await settle();

        expect(fakes.navigate).not.toHaveBeenCalled();
    });
});

describe('MainPageComponent events panel permissions', () => {
    beforeEach(() => TestBed.resetTestingModule());
    afterEach(() => vi.restoreAllMocks());

    it('clears then refetches when the panel opens for a guild', async () => {
        const {fixture, component, fakes} = await setup();
        expect(component.eventsMemberPermissions()).toBe('');

        fakes.eventsPanelGuildId.set('g1');
        fixture.detectChanges();

        expect(fakes.getOwnMember).toHaveBeenCalledWith('g1');
        expect(typeof component.eventsMemberPermissions()).toBe('string');
    });

    it('clears the permissions when the fetch fails', async () => {
        const {fixture, component, fakes} = await setup();
        fakes.getOwnMember.mockReturnValue(throwError(() => new Error('nope')));

        fakes.eventsPanelGuildId.set('g1');
        fixture.detectChanges();

        expect(component.eventsMemberPermissions()).toBe('');
    });

    it('clears the permissions when the panel closes', async () => {
        const {fixture, component, fakes} = await setup();
        fakes.eventsPanelGuildId.set('g1');
        fixture.detectChanges();

        fakes.eventsPanelGuildId.set(null);
        fixture.detectChanges();

        expect(component.eventsMemberPermissions()).toBe('');
    });
});

/** Kept out of the fake graph deliberately: these are pure and have their own specs. */
describe('MainPageComponent view helpers', () => {
    beforeEach(() => TestBed.resetTestingModule());
    afterEach(() => vi.restoreAllMocks());

    it('defaults onboarding off outside a server', async () => {
        const {component} = await setup();

        expect(component.onboardingEnabled()).toBe(false);
        expect(component.openPostForum()).toBeNull();
    });

    it('openAccountSettings forwards to the quick settings panel', async () => {
        const {component} = await setup();
        const openProfileSettings = vi.fn();
        component.quickSettings = (() => ({openProfileSettings})) as unknown as never;

        component.openAccountSettings();

        expect(openProfileSettings).toHaveBeenCalled();
    });
});
