import {Component, computed, effect, HostListener, inject, OnDestroy, signal, ViewChild} from '@angular/core';
import {AuthService} from '../../services/auth.service';
import {Router} from '@angular/router';
import {HomeComponent} from './pages/home/home.component';
import {MobileConversationsPageComponent} from './pages/mobile-conversations/mobile-conversations-page.component';
import {OAuthService} from 'angular-oauth2-oidc';
import {MessagingWebsocketService} from '../../services/messaging-websocket.service';
import {ActionSidepanelComponent} from './components/action-sidepanel/action-sidepanel.component';
import {ConversationComponent} from '../messaging/components/conversation/conversation.component';
import {ChannelComponent} from '../guild/components/channel/channel.component';
import {VoiceChannelComponent} from '../guild/components/voice-channel/voice-channel.component';
import {ForumChannelComponent} from '../guild/components/forum-channel/forum-channel.component';
import {ForumPostListComponent} from '../guild/components/forum-channel/forum-post-list.component';
import {forumParentOf} from '../guild/components/channel/channel-utils';
import {stringifyPermissions} from '../../enums/permissions.enum';
import {unionMemberPermissions} from '../guild/guild-permissions';
import {ServerTaskbarComponent} from '../guild/components/server-taskbar/server-taskbar.component';
import {ActivityFeedComponent} from './components/activity-feed/activity-feed.component';
import {ConversationInfoPanelComponent} from '../messaging/components/conversation-info-panel/conversation-info-panel.component';
import {NavigationService} from './navigation.service';
import {NotificationService} from '../../services/notification.service';
import {HouseholdAlertService} from '../../services/household-alert.service';
import {ConversationStore} from '../../stores/conversation.store';
import {firstValueFrom, Subscription} from 'rxjs';
import {VoiceWebsocketService} from '../../services/voice-websocket.service';
import {ProfilePopoutComponent} from '../../components/profile-popout/profile-popout.component';
import {ProfileModalComponent} from '../../components/profile-modal/profile-modal.component';
import {ProfilePopoutService} from '../../services/profile-popout.service';
import {QuickSettingsComponent} from './components/quick-settings/quick-settings.component';
import {AccountDeletionBannerComponent} from './components/account-deletion-banner/account-deletion-banner.component';
import {VoiceResumeBannerComponent} from './components/voice-resume-banner/voice-resume-banner.component';
import {VoiceStatusBarComponent} from './components/voice-status-bar/voice-status-bar.component';
import {channelViewFor} from '../guild/channel-types';
import {UnsupportedChannelComponent} from '../guild/components/unsupported-channel/unsupported-channel.component';
// The five household channel views.
import {ListChannelComponent} from '../guild/components/list-channel/list-channel.component';
import {ChoresChannelComponent} from '../guild/components/chores-channel/chores-channel.component';
import {LedgerChannelComponent} from '../guild/components/ledger-channel/ledger-channel.component';
import {PantryChannelComponent} from '../guild/components/pantry-channel/pantry-channel.component';
import {DecisionsChannelComponent} from '../guild/components/decisions-channel/decisions-channel.component';
import {MealsChannelComponent} from '../guild/components/meals-channel/meals-channel.component';
import {MaintenanceChannelComponent} from '../guild/components/maintenance-channel/maintenance-channel.component';
import {HouseHomeComponent} from '../guild/components/house-home/house-home.component';
import {GuildMemberListComponent} from '../guild/components/guild-member-list/guild-member-list.component';
import {UserTokenService} from '../../services/user-token.service';
import {GuildWebsocketService} from '../../services/guild-websocket.service';
import {SocialWebsocketService} from '../../services/social-websocket.service';
import {UserService} from '../../services/user.service';
import {KeySetupDialogComponent} from '../key-setup/key-setup-dialog/key-setup-dialog.component';
import {MasterKeyRecoveryDialogComponent} from '../key-setup/master-key-recovery-dialog/master-key-recovery-dialog.component';
import {MasterKeyStateService} from '../../services/master-key-state.service';
import {MlsService} from '../../services/mls.service';
import {MlsSyncService} from '../../services/mls-sync.service';
import {MlsHealthService} from '../../services/mls-health.service';
import {DeviceRegistrationModalComponent} from '../device-registration/device-registration-modal/device-registration-modal.component';
import {ConversationService} from '../../services/conversation.service';
import {RichPresenceService} from '../../services/rich-presence.service';
import {WikiComponent} from '../guild/components/wiki/wiki.component';
import {OnboardingGateComponent} from '../guild/components/onboarding-gate/onboarding-gate.component';
import {EventsPanelComponent} from '../guild/components/events-panel/events-panel.component';
import {GuildFeature, guildHasFeature, hasHouseholdModule} from '../guild/guild-features';
import {EmailVerificationService} from '../../services/email-verification.service';
import {AppReadyService} from '../../services/app-ready.service';
import {GuildService} from '../../services/guild.service';
import {runMlsLaunch} from './mls-launch';
import {runMlsStorageInit} from './mls-storage-init';
import {relaunchOnSessionTakeover} from './mls-takeover';
import {runSignOut} from './sign-out';
import {AccountGateBlock, hydrateThenReveal, revealAfterAccountGateBlock} from './profile-cache-hydration';
import {MlsJoinRequestService} from '../../services/mls-join-request.service';
import {ConversationEncryption} from '../../enums/conversation-encryption.enum';
import {AccountOnboardingComponent} from '../onboarding/account-onboarding.component';
import {UserDto} from '../../dtos/response/UserDto';
import {OnboardingService} from '../../services/onboarding.service';
import {SocialKeyGateService} from '../../services/social-key-gate.service';
import {AccountRegistryService} from '../../services/account-registry.service';
import {AccountSwitchService} from '../../services/account-switch.service';
import {SessionTeardownService} from '../../services/session-teardown.service';
import {ApiConfigService} from '../../services/api-config.service';
import {ProfileService} from '../../services/profile.service';
import {ProfileCacheService} from '../../services/cache/profile-cache.service';
import {ReportDialogComponent} from '../../components/report-dialog/report-dialog.component';
import {
    GoLiveNotificationService,
    STREAM_LIVE_ACTION_TYPE,
} from '../../services/go-live-notification.service';
import {CallFocusService} from '../../services/call-focus.service';
import {VoiceChannelService} from '../../services/voice-channel.service';
import {VoiceResumeService} from '../../services/voice-resume.service';
import {scopeKey} from '../../services/share-watch.service';

@Component({
    selector: 'app-main-page',
    imports: [
        HomeComponent,
        MobileConversationsPageComponent,
        ActionSidepanelComponent,
        ConversationComponent,
        ChannelComponent,
        VoiceChannelComponent,
        ForumChannelComponent,
        UnsupportedChannelComponent,
        ListChannelComponent,
        ChoresChannelComponent,
        LedgerChannelComponent,
        PantryChannelComponent,
        DecisionsChannelComponent,
        MealsChannelComponent,
        MaintenanceChannelComponent,
        HouseHomeComponent,
        ServerTaskbarComponent,
        ActivityFeedComponent,
        ConversationInfoPanelComponent,
        ProfilePopoutComponent,
        ProfileModalComponent,
        QuickSettingsComponent,
        AccountDeletionBannerComponent,
        VoiceResumeBannerComponent,
        VoiceStatusBarComponent,
        GuildMemberListComponent,
        DeviceRegistrationModalComponent,
        KeySetupDialogComponent,
        MasterKeyRecoveryDialogComponent,
        WikiComponent,
        OnboardingGateComponent,
        AccountOnboardingComponent,
        EventsPanelComponent,
        ForumPostListComponent,
        ReportDialogComponent,
    ],
    templateUrl: './main-page.component.html',
    styleUrl: './main-page.component.css',
})
export class MainPageComponent implements OnDestroy {
    protected authService = inject(AuthService);
    protected oAuthService = inject(OAuthService);
    protected navService = inject(NavigationService);
    protected profilePopout = inject(ProfilePopoutService);
    /** Routing is an allowlist: an unrecognised type resolves to 'unsupported', never 'message'. */
    protected readonly channelViewFor = channelViewFor;
    /** The rules gate, prompts and welcome screen all belong to the Onboarding module. */
    protected readonly onboardingEnabled = computed(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' && guildHasFeature(ws.guild, GuildFeature.Onboarding);
    });
    /** The forum whose post list sits beside the main view: non-null only when the open channel is a forum post. */
    protected readonly openPostForum = computed(() => {
        const view = this.navService.mainView();
        if (view.type !== 'channel') return null;
        const ws = this.navService.workspace();
        if (ws.type !== 'server') return null;
        return forumParentOf(view.channel, ws.guild.channels);
    });
    protected router = inject(Router);
    protected readonly showDeviceRegistration = signal(false);
    /** The account picker, and the gate that owns the key-setup dialog. See {@link SocialKeyGateService}. */
    protected onboarding = inject(OnboardingService);
    protected socialGate = inject(SocialKeyGateService);
    /** A password reset left the encryption key unopenable, or the account has no recovery code. */
    protected readonly showMasterKeyRecovery = signal(false);
    /** The key store could not be reached. Not the same state as "this device is not registered". */
    protected readonly keyUnlockFailed = signal(false);
    /** Part of this device's signing key is in the key store and part is not; must not offer registration. */
    protected readonly keyStoreIncomplete = signal(false);
    /** MLS storage could not be initialised and the local state was kept; set only on non-wiping paths. */
    protected readonly mlsStorageUnavailable = signal(false);
    /** The server holds no fresh key packages for this device, because uploading them failed. */
    protected readonly keyPackagesFailed = signal(false);
    /** Serialized permission string for the events panel, re-fetched whenever it's opened for a guild. */
    protected readonly eventsMemberPermissions = signal('');
    @ViewChild(QuickSettingsComponent) private quickSettings!: QuickSettingsComponent;
    /** Opaque handle for the session-loaded signing key, set after device unlock. */
    protected readonly keyHandle = signal<string | null>(null);
    private websocketService = inject(MessagingWebsocketService);
    private voiceWebsocketService = inject(VoiceWebsocketService);
    private guildWebsocketService = inject(GuildWebsocketService);
    private socialWebsocketService = inject(SocialWebsocketService);
    private notificationService = inject(NotificationService);
    /** Injected for its constructor side effect only; removing the injection silently kills household alerts. */
    private householdAlerts = inject(HouseholdAlertService);
    /** Injected for its constructor side effect only; removing the injection silently kills go-live notifications. */
    private goLiveNotifications = inject(GoLiveNotificationService);
    private callFocus = inject(CallFocusService);
    private voiceChannelSvc = inject(VoiceChannelService);
    private voiceResume = inject(VoiceResumeService);
    private conversationStore = inject(ConversationStore);
    private userTokenService = inject(UserTokenService);
    private userService = inject(UserService);
    private mlsService = inject(MlsService);
    private mlsSync = inject(MlsSyncService);
    private mlsHealth = inject(MlsHealthService);
    private masterKeyState = inject(MasterKeyStateService);
    private conversationService = inject(ConversationService);
    private richPresenceService = inject(RichPresenceService);
    private emailVerification = inject(EmailVerificationService);
    // Protected so the template can expose readiness to the DOM via `data-testid="app-ready"`.
    protected appReady = inject(AppReadyService);
    private guildService = inject(GuildService);
    private joinRequests = inject(MlsJoinRequestService);
    private accounts = inject(AccountRegistryService);
    private switcher = inject(AccountSwitchService);
    private teardown = inject(SessionTeardownService);
    private apiConfig = inject(ApiConfigService);
    private profileService = inject(ProfileService);
    private profileCache = inject(ProfileCacheService);
    /** Conversations read for the launch-time §B sweep. Filtering them costs no requests. */
    private static readonly SWEEP_PAGE_SIZE = 100;
    private actionSub = new Subscription();

    constructor() {
        void this.websocketService.start();
        void this.voiceWebsocketService.start();
        void this.guildWebsocketService.start();
        void this.socialWebsocketService.start();

        this.userTokenService.ensureTokenRegistered().then();
        void this.initLaunchSequence();

        // The picker suspends the launch sequence, so answering it has to start the second half.
        this.actionSub.add(this.onboarding.pickerCompleted.subscribe(() => void this.runDeviceLaunch()));

        // A tab that booted while another tab owned the engine unlocked nothing, so gaining the
        // engine has to relaunch. See {@link relaunchOnSessionTakeover}; never fires on the desktop.
        this.actionSub.add(
            relaunchOnSessionTakeover({
                takeovers: () => this.mlsService.sessionTakeovers(),
                relaunch: () => this.runDeviceLaunch(),
            }),
        );

        // Refresh through the same deduplicated ensureValidToken() the sockets and interceptor use,
        // so nothing else spends the single-use refresh token in parallel.
        this.actionSub.add(
            this.oAuthService.events.subscribe(e => {
                if (e.type === 'token_expires') {
                    void this.authService.ensureValidToken().catch(() => {});
                }
                if (e.type === 'token_refresh_error' || e.type === 'silent_refresh_error') {
                    const reason = (e as any)?.reason;
                    const status = reason?.status ?? reason?.error?.status;
                    if (status === 403) {
                        this.emailVerification.show(this.resolveEmail(), {action: 'navigate-login'});
                    }
                }
            }),
        );

        this.richPresenceService.start();

        // Refetches own member permissions whenever the events panel is opened for a guild. Reads
        // only eventsPanelGuildId() and writes a separate signal, so it can't re-trigger itself.
        effect(() => {
            const guildId = this.navService.eventsPanelGuildId();
            // Clear first, unconditionally: otherwise the previous guild's permissions stay live
            // while the next request is in flight, and for the whole session if that request fails.
            this.eventsMemberPermissions.set('');
            if (!guildId) return;
            this.guildService.getOwnMember(guildId).subscribe({
                // Re-serialized from the parsed union: a mask can arrive as a JSON number, and the
                // panel takes names.
                next: m => this.eventsMemberPermissions.set(stringifyPermissions(unionMemberPermissions(m))),
                error: () => this.eventsMemberPermissions.set(''),
            });
        });

        this.actionSub.add(
            this.notificationService.action$.subscribe(event => {
                const {conversationId, type} = event.extra;
                if (conversationId) {
                    const conv = this.conversationStore.entities().find(c => c.id === conversationId);
                    if (conv) this.navService.openConversation(conv);
                    return;
                }
                if (type === 'household') this.openHouseholdTarget(event.extra);
                if (type === STREAM_LIVE_ACTION_TYPE) this.openStreamTarget(event.extra);
            }),
        );

        // The push names a context but carries nothing else: the fetch is device-scoped, and the
        // Welcome is only acknowledged once its join has actually worked.
        this.actionSub.add(
            this.websocketService.welcomeObservable.subscribe(async () => {
                try {
                    await this.mlsSync.processPendingWelcomes();
                } catch (err) {
                    console.error('Failed to process pending Welcomes', err);
                }
            }),
        );

        // A commit landed. The payload is a nudge only: commits apply in epoch order, never in
        // push-arrival order.
        this.actionSub.add(
            this.websocketService.mlsCommitObservable.subscribe(async event => {
                try {
                    await this.mlsSync.syncContext(event.contextId, event.isChannel);
                } catch (err) {
                    console.error('Failed to apply MLS commits', event.contextId, err);
                }
            }),
        );

        // Encryption was switched on or off. Re-reading the state stops this client encrypting to a
        // replaced group, or sending plaintext into one that has not been replaced.
        this.actionSub.add(
            this.websocketService.mlsStateChangedObservable.subscribe(async event => {
                try {
                    await this.mlsSync.refreshState(event.contextId, event.isChannel);
                } catch (err) {
                    console.error('Failed to refresh MLS state', event.contextId, err);
                }
            }),
        );
    }

    public logout(): void {
        void this.goToLogin();
    }

    protected openAccountSettings(): void {
        this.quickSettings.openProfileSettings();
    }

    /** Where a clicked household notification lands: the channel in the payload, else the guild. */
    private openHouseholdTarget(extra: Record<string, string>): void {
        const guild = this.guildService.guilds().find(g => g.id === extra['guildId']);
        if (!guild) return;
        this.navService.selectServer(guild);

        const channel = guild.channels.find(c => c.id === extra['channelId']);
        if (channel) this.navService.openChannel(channel);
        else if (hasHouseholdModule(guild)) this.navService.openHouse(guild.id);
    }

    /**
     * Where a clicked go-live notification lands: the channel, focused on that person's stream.
     * The focus request is armed at click time because `CallFocusService` requests expire on a TTL.
     */
    private async openStreamTarget(extra: Record<string, string>): Promise<void> {
        const guild = this.guildService.guilds().find(g => g.id === extra['guildId']);
        if (!guild) return;
        this.navService.selectServer(guild);

        const channel = guild.channels.find(c => c.id === extra['channelId']);
        if (!channel) return;
        this.navService.openChannel(channel);
        if (this.voiceChannelSvc.joinedChannelId() !== channel.id) {
            // A refused join has already said so, and the focus request needs a stage that mounts.
            if (!(await this.voiceChannelSvc.joinChannel(channel, guild.name))) return;
        }

        this.callFocus.request(scopeKey({kind: 'channel', guildId: guild.id, channelId: channel.id}), {
            userId: extra['userId'],
        });
    }

    @HostListener('document:keydown', ['$event'])
    onKeydown(event: KeyboardEvent): void {
        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'l') {
            this.goToLogin();
        }
    }

    ngOnDestroy(): void {
        this.actionSub.unsubscribe();
        this.richPresenceService.stop();
    }

    protected onDeviceRegistered(keyHandle: string): void {
        this.keyHandle.set(keyHandle);
        this.showDeviceRegistration.set(false);
        this.checkMasterKey();
        this.userService.replenishKeyCount().subscribe();
    }

    /** Sign out, taking this device's key material with it. See {@link runSignOut}. */
    private goToLogin(): Promise<unknown> {
        return runSignOut({
            deviceId: () => this.mlsService.getOrCreateDeviceIdentifier(),
            clearActivity: () => this.richPresenceService.stop(),
            wipeAccount: id => this.teardown.wipeAccount(id),
            clearGuildCache: () => this.guildService.forgetCachedGuilds(),
            dropTokens: () => this.authService.logout(),
            goToLogin: () => void this.router.navigate(['/authentication']),
        });
    }

    /**
     * Launch sequence in two halves: the account's own gates, then this device's crypto state.
     * The first half can suspend, so {@link OnboardingService.pickerCompleted} restarts the second.
     */
    private async initLaunchSequence(): Promise<void> {
        const gate = await this.resolveAccountGates();
        if (gate !== 'continue') {
            // A blocking dialog owns the screen, so still mark ready or it sits behind the splash.
            // Hydrate only once this account has a slot: doing it earlier writes under
            // BOOTSTRAP_SLOT_ID, which no wipe is ever handed the id of.
            await revealAfterAccountGateBlock(
                gate,
                {
                    hydrate: () => this.profileCache.hydrate(),
                    revalidateAll: () => this.profileCache.revalidateAll(),
                    markReady: () => this.appReady.markReady(),
                },
                async () => (await this.accounts.activeSlot()) !== null,
            );
            return;
        }
        await this.runDeviceLaunch();
    }

    /**
     * Answers the account-level questions, and reports whether the launch may continue. Anything
     * other than `'continue'` means a blocking dialog now owns the screen.
     */
    private async resolveAccountGates(): Promise<'continue' | AccountGateBlock> {
        let user: UserDto;
        try {
            user = await firstValueFrom(this.userService.getSelf());
        } catch (err) {
            if ((err as {status?: number} | null)?.status === 403) {
                this.emailVerification.show(this.resolveEmail(), {action: 'navigate-login'});
                return 'email-verification';
            }
            // The device half below depends on none of these answers, and refusing to launch over a
            // failed profile fetch would strand the user on a splash screen.
            console.error('Failed to fetch user:', err);
            return 'continue';
        }

        // Must precede anything that reads a device id or opens a store: every local MLS name is
        // derived from this slot's device id.
        await this.establishAccountSlot(user);

        if (user.email) this.emailVerification.storeKnownEmail(user.email);
        if (!user.emailVerifiedAt) {
            this.emailVerification.show(user.email || this.resolveEmail());
            return 'email-verification';
        }
        if (this.onboarding.needsOnboarding()) {
            this.onboarding.show();
            return 'onboarding';
        }
        return 'continue';
    }

    /**
     * Makes this account's slot live, so the device id and every store named after it resolve to
     * this account rather than to whoever was here last.
     */
    private async establishAccountSlot(user: UserDto): Promise<void> {
        // Through the switcher, not the registry: a sign-in writes its tokens to the bootstrap slot,
        // and moving them onto this slot is part of becoming it.
        const slot = await this.switcher.adoptSignedInAccount({
            userId: user.id,
            serverUrl: this.apiConfig.baseUrl(),
        });

        try {
            const profile = await firstValueFrom(this.profileService.getSelf());
            await this.accounts.updateProfile(slot.id, {
                username: profile.userName,
                avatarUrl: profile.avatarUrl ?? null,
            });
        } catch (err) {
            console.error('Could not label the account slot', err);
        }
    }

    private async runDeviceLaunch(): Promise<void> {
        const deviceId = await this.mlsService.getOrCreateDeviceIdentifier();

        // Must stay here, ahead of the network work below: `AppReadyService`'s 8s safety net lifts
        // the splash regardless, and a splash lifted over an empty profile map shows raw `user_...`.
        await hydrateThenReveal({
            hydrate: () => this.profileCache.hydrate(),
            revalidateAll: () => this.profileCache.revalidateAll(),
            markReady: () => this.appReady.markReady(),
        });

        // May wipe only when the state file is present and unreadable; every other `initStorage`
        // failure keeps the local state and gets a retry.
        const storage = await runMlsStorageInit({
            initStorage: () => firstValueFrom(this.mlsService.initStorage()),
            wipe: () => this.wipeLocalMlsState(deviceId),
        });
        if (storage.wiped) {
            console.error(
                'MLS state is present and unreadable, wiped and starting fresh:',
                storage.fault?.message,
            );
        } else if (storage.fault) {
            console.error(
                `MLS storage could not be initialised (${storage.fault.kind}), local state kept, ` +
                    'nothing wiped:',
                storage.fault.message,
            );
        }
        // Cleared as well as set, so a successful retry takes the banner down.
        this.mlsStorageUnavailable.set(storage.fault !== null && !storage.wiped);

        // Who the engine is expected to be holding keys for. Read from the slot rather than kept as
        // a field, so the path that resumes here after the onboarding picker has it too.
        const expectedUserId = (await this.accounts.activeSlot())?.userId;

        const outcome = await runMlsLaunch({
            unlock: () => firstValueFrom(this.mlsService.autoUnlock(deviceId, expectedUserId)),
            replenish: () => firstValueFrom(this.userService.replenishKeyCount()),
            checkMasterKey: () => this.promptForMasterKeyIfOwed(),
            processWelcomes: () => this.mlsSync.processPendingWelcomes(),
            sweepForAdmission: () => this.sweepForAdmission(),
        });

        if (outcome.handle) this.keyHandle.set(outcome.handle);
        // `needsRegistration` is the only outcome that may register: any other would mint a fresh
        // keypair over live group state.
        this.showDeviceRegistration.set(outcome.needsRegistration);
        // Same banner as an unreachable key store: both mean encryption is unavailable this launch
        // and registering is not the answer.
        this.keyUnlockFailed.set(
            outcome.keyStoreUnreachable || outcome.identityMismatch || outcome.keyStoreIncomplete,
        );
        this.keyStoreIncomplete.set(outcome.keyStoreIncomplete);
        if (outcome.identityMismatch) {
            console.error(
                'The signing key stored for this device belongs to another account - the account ' +
                    'slot resolved to the wrong device id',
            );
        }
        if (outcome.keyStoreIncomplete) {
            console.error(
                "This device's signing key is only partly in the key store - registration is " +
                    'deliberately not offered, because minting a fresh keypair over the part that is ' +
                    'still there would orphan this device from every group it belongs to',
            );
        }
        this.keyPackagesFailed.set(outcome.keyPackagesFailed);

        // Last: two cheap reads nothing else waits on, and it only asks about time spent not running.
        this.voiceResume.check();
    }

    /**
     * Contract §B discovery: asks to be admitted to any conversation this device is locked out of.
     * Conversations only; channels carry their own ask affordance in `ChannelAccessBannerComponent`.
     */
    private async sweepForAdmission(): Promise<void> {
        const conversations = await firstValueFrom(
            this.conversationService.getConversations(0, MainPageComponent.SWEEP_PAGE_SIZE),
        );

        const outcome = await this.joinRequests.sweepForAdmission(
            conversations.map(c => ({
                contextId: c.id,
                isChannel: false,
                // Only ever used to decide whether to *ask*; the local encryption floor guards the
                // other direction.
                serverSaysEncrypted: c.encryptionState === ConversationEncryption.Encrypted,
            })),
        );

        if (outcome.probed > 0) {
            console.info('MLS admission sweep', outcome);
        }
    }

    /** Retries just the key-package upload, from the strip that reports it failed. */
    protected async replenishKeyPackages(): Promise<void> {
        this.keyPackagesFailed.set(false);
        try {
            await firstValueFrom(this.userService.replenishKeyCount());
        } catch (err) {
            this.keyPackagesFailed.set(true);
            console.error('Could not replenish the MLS key packages for this device', err);
        }
    }

    /** Retry after a transient key-store failure, without minting anything. */
    protected async retryUnlock(): Promise<void> {
        this.keyUnlockFailed.set(false);
        this.keyStoreIncomplete.set(false);
        await this.initLaunchSequence();
    }

    /** Retry after MLS storage could not be initialised. Not a wipe: the state is still on disk. */
    protected async retryMlsStorage(): Promise<void> {
        this.mlsStorageUnavailable.set(false);
        await this.initLaunchSequence();
    }

    /**
     * Recovers from a state file this device can no longer read. The signing key is deliberately
     * kept; see {@link SessionTeardownService.wipeEngineState}.
     */
    private async wipeLocalMlsState(deviceId: string): Promise<void> {
        const outcome = await this.teardown.wipeEngineState(deviceId);
        this.mlsHealth.clear();

        if (!outcome.keyPackagesReset) {
            // Not fatal to launch, but this device stays unreachable until the reset succeeds.
            this.mlsHealth.recordFailure(
                deviceId,
                false,
                'not-admitted',
                new Error('key packages were not reset after a local wipe'),
            );
        }
    }

    /** The master-key launch gate, read from the account already fetched by {@link resolveAccountGates}. */
    private promptForMasterKeyIfOwed(): void {
        const user = this.userService.self();
        if (!user) return;

        if (!user.encryptedMasterKey) {
            // Isle-only accounts are let through with no key: the master key encrypts the device
            // backup, not the messages. The ask returns as soon as they reach for something social.
            if (this.onboarding.wantsSocial()) this.socialGate.promptNow();
            return;
        }
        // Having a master key and being able to *open* it are different questions.
        void this.checkMasterKeyHealth();
    }

    /** Re-reads the account, then applies the master-key gate. Used after device registration. */
    private checkMasterKey(): void {
        this.userService.getSelf().subscribe({
            next: () => this.promptForMasterKeyIfOwed(),
            error: err => {
                const status = (err as {status?: number} | null)?.status;
                if (status === 403) {
                    this.emailVerification.show(this.resolveEmail(), {action: 'navigate-login'});
                } else {
                    console.error('Failed to fetch user:', err);
                }
            },
        });
    }

    /**
     * Asks whether a password reset has left the master key unopenable, and surfaces the repair.
     * Runs on every unlock, because the reset may have happened on another device.
     */
    private async checkMasterKeyHealth(): Promise<void> {
        try {
            const action = await this.masterKeyState.refresh();
            if (action !== 'ok' && action !== 'not-set-up') this.showMasterKeyRecovery.set(true);
        } catch (err) {
            console.error('Could not check master key health', err);
        }
    }

    private resolveEmail(): string {
        const known = this.emailVerification.knownEmail();
        if (known) return known;
        const claims = this.oAuthService.getIdentityClaims() as Record<string, unknown> | null;
        return (claims?.['email'] ?? claims?.['sub'] ?? '') as string;
    }
}
