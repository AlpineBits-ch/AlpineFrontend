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
import {
    ConversationInfoPanelComponent
} from '../messaging/components/conversation-info-panel/conversation-info-panel.component';
import {NavigationService} from './navigation.service';
import {NotificationService} from '../../services/notification.service';
import {HouseholdAlertService} from '../../services/household-alert.service';
import {ConversationStore} from '../../stores/conversation.store';
import {firstValueFrom, Subscription} from 'rxjs';
import {VoiceWebsocketService} from '../../services/voice-websocket.service';
import {ProfileDialogComponent} from '../../components/profile-dialog/profile-dialog.component';
import {ProfileDialogService} from '../../services/profile-dialog.service';
import {QuickSettingsComponent} from './components/quick-settings/quick-settings.component';
import {AccountDeletionBannerComponent} from './components/account-deletion-banner/account-deletion-banner.component';
import {VoiceStatusBarComponent} from './components/voice-status-bar/voice-status-bar.component';
import {channelViewFor} from '../guild/channel-types';
import {UnsupportedChannelComponent} from '../guild/components/unsupported-channel/unsupported-channel.component';
// The five household channel views. Each is a full page like ChannelComponent, and each
// takes the same (channel, back) pair - the back output is what gives a phone a way out
// of a channel whose left nav is off-screen below `lg`.
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
import {
    MasterKeyRecoveryDialogComponent
} from '../key-setup/master-key-recovery-dialog/master-key-recovery-dialog.component';
import {MasterKeyStateService} from '../../services/master-key-state.service';
import {MlsService} from '../../services/mls.service';
import {MlsSyncService} from '../../services/mls-sync.service';
import {MlsHealthService} from '../../services/mls-health.service';
import {
    DeviceRegistrationModalComponent
} from '../device-registration/device-registration-modal/device-registration-modal.component';
import {ConversationService} from "../../services/conversation.service";
import {RichPresenceService} from "../../services/rich-presence.service";
import {WikiComponent} from '../guild/components/wiki/wiki.component';
import {OnboardingGateComponent} from '../guild/components/onboarding-gate/onboarding-gate.component';
import {EventsPanelComponent} from '../guild/components/events-panel/events-panel.component';
import {GuildFeature, guildHasFeature, hasHouseholdModule} from '../guild/guild-features';
import {EmailVerificationService} from '../../services/email-verification.service';
import {AppReadyService} from '../../services/app-ready.service';
import {GuildService} from '../../services/guild.service';
import {runMlsLaunch} from './mls-launch';
import {runSignOut} from './sign-out';
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
import {ReportDialogComponent} from '../../components/report-dialog/report-dialog.component';

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
        ProfileDialogComponent,
        QuickSettingsComponent,
        AccountDeletionBannerComponent,
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
    protected profileDialogSvc = inject(ProfileDialogService);
    /** Routing is an allowlist: an unrecognised type resolves to 'unsupported', never 'message'. */
    protected readonly channelViewFor = channelViewFor;
    /** The rules gate, prompts and welcome screen all belong to the Onboarding module. */
    protected onboardingEnabled = computed(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' && guildHasFeature(ws.guild, GuildFeature.Onboarding);
    });
    /**
     * The forum whose post list should sit beside the main view: non-null exactly when the
     * open channel is a forum post. Desktop only - below `lg` the pane is hidden and the
     * post keeps the whole screen, as it always has.
     */
    protected openPostForum = computed(() => {
        const view = this.navService.mainView();
        if (view.type !== 'channel') return null;
        const ws = this.navService.workspace();
        if (ws.type !== 'server') return null;
        return forumParentOf(view.channel, ws.guild.channels);
    });
    protected router = inject(Router);
    protected showDeviceRegistration = signal(false);
    /**
     * The account picker, and the gate that owns the key-setup dialog for both the launch-time and
     * the deferred path. One dialog instance, two ways in - see {@link SocialKeyGateService}.
     */
    protected onboarding = inject(OnboardingService);
    protected socialGate = inject(SocialKeyGateService);
    /** A password reset left the encryption key unopenable, or the account has no recovery code. */
    protected showMasterKeyRecovery = signal(false);
    /**
     * The key store could not be reached. Deliberately *not* the same state as "this device is not
     * registered" - see {@link initLaunchSequence} for why conflating them is unrecoverable.
     */
    protected keyUnlockFailed = signal(false);
    /**
     * The server holds no fresh key packages for this device, because uploading them failed.
     *
     * <p>Its own state, and surfaced: while it is true this device is reported as unreachable to
     * everyone who tries to add it, so it is silently left out of every conversation created from
     * now on - the exact shape of "readable on my phone, not on my desktop".</p>
     */
    protected keyPackagesFailed = signal(false);
    /** Serialized permission string for the events panel -re-fetched whenever it's opened for a guild, mirroring the ownMember-fetch pattern used by every other permission-gated guild panel. */
    protected eventsMemberPermissions = signal('');
    @ViewChild(QuickSettingsComponent) private quickSettings!: QuickSettingsComponent;
    /** Opaque handle for the session-loaded signing key -set after device unlock. */
    protected keyHandle = signal<string | null>(null);
    private websocketService = inject(MessagingWebsocketService);
    private voiceWebsocketService = inject(VoiceWebsocketService);
    private guildWebsocketService = inject(GuildWebsocketService);
    private socialWebsocketService = inject(SocialWebsocketService);
    private notificationService = inject(NotificationService);
    /**
     * Injected for its constructor, not for anything called on it.
     *
     * <p>`guild.HouseholdAlert` is the one household event that must reach somebody who is not
     * looking at the module it came from - a chore due, an expense they owe a share of, a decision
     * somebody blocked. A root service only starts listening once something injects it, so leaving
     * this to the boards would mean the alert only worked for people who had already opened the
     * board it was telling them about. The shell is what is always there.</p>
     */
    private householdAlerts = inject(HouseholdAlertService);
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
    // Protected rather than private so the template can expose readiness to the DOM. See the
    // `data-testid="app-ready"` binding on the root element: removing the loading overlay is not
    // evidence that the app booted, because AppComponent's safety-net timer removes it either way.
    protected appReady = inject(AppReadyService);
    private guildService = inject(GuildService);
    private joinRequests = inject(MlsJoinRequestService);
    private accounts = inject(AccountRegistryService);
    private switcher = inject(AccountSwitchService);
    private teardown = inject(SessionTeardownService);
    private apiConfig = inject(ApiConfigService);
    private profileService = inject(ProfileService);
    /** Conversations read for the launch-time Â§B sweep. Filtering them costs no requests. */
    private static readonly SWEEP_PAGE_SIZE = 100;
    private actionSub = new Subscription();

    constructor() {
        void this.websocketService.start();
        void this.voiceWebsocketService.start();
        void this.guildWebsocketService.start();
        void this.socialWebsocketService.start();

        this.userTokenService.ensureTokenRegistered().then();
        void this.initLaunchSequence();

        // The picker suspends the launch sequence - it owns the screen and there is nothing left
        // to run - so answering it has to start the second half. Without this the answer appeared
        // to do nothing at all: device registration and the key-setup prompt both waited for the
        // next launch, and reloading was the only way to make the app act on the choice.
        this.actionSub.add(
            this.onboarding.pickerCompleted.subscribe(() => void this.runDeviceLaunch()));

        // Proactively refresh the token before expiry using the same deduplicated
        // ensureValidToken() that the WS accessTokenFactories and interceptor use.
        // This avoids the race where setupAutomaticSilentRefresh() calls refreshToken()
        // independently from the interceptor, both using the same single-use refresh token.
        this.actionSub.add(
            this.oAuthService.events.subscribe(e => {
                if (e.type === 'token_expires') {
                    void this.authService.ensureValidToken().catch(() => {
                    });
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

        // Detection now publishes to the server and renders itself through
        // {@link UserActivityService}, so the effect that used to log `currentGame()` to the
        // console - the feature's only consumer - is gone along with the signal it read.
        this.richPresenceService.start();

        // Refetches own member permissions whenever the events panel is opened for a
        // guild -only reads eventsPanelGuildId() and writes a separate signal, so it
        // can't re-trigger itself.
        effect(() => {
            const guildId = this.navService.eventsPanelGuildId();
            // Clear first, unconditionally: otherwise the previous guild's permissions stay
            // live while guild B's request is in flight (a non-manager would briefly see the
            // manage controls), and persist for the whole session if that request fails.
            this.eventsMemberPermissions.set('');
            if (!guildId) return;
            this.guildService.getOwnMember(guildId).subscribe({
                // Re-serialized from the parsed union rather than joined off the wire: a mask can
                // arrive as a JSON number, and one numeric source poisons the whole comma-joined
                // string. The panel takes names, so hand it names.
                next: m => this.eventsMemberPermissions.set(stringifyPermissions(unionMemberPermissions(m))),
                error: () => this.eventsMemberPermissions.set(''),
            });
        });

        this.actionSub.add(this.notificationService.action$.subscribe(event => {
            const {conversationId, type} = event.extra;
            if (conversationId) {
                const conv = this.conversationStore.entities().find(c => c.id === conversationId);
                if (conv) this.navService.openConversation(conv);
                return;
            }
            if (type === 'household') this.openHouseholdTarget(event.extra);
        }));

        // The push names a context but carries nothing else: the fetch is device-scoped, and the
        // Welcome is only acknowledged once its join has actually worked.
        this.actionSub.add(this.websocketService.welcomeObservable.subscribe(async () => {
            try {
                await this.mlsSync.processPendingWelcomes();
            } catch (err) {
                console.error('Failed to process pending Welcomes', err);
            }
        }));

        // A commit landed. The payload is a nudge only - group state advances by fetching commits
        // above our own epoch and applying them in order, never in push-arrival order.
        this.actionSub.add(this.websocketService.mlsCommitObservable.subscribe(async (event) => {
            try {
                await this.mlsSync.syncContext(event.contextId, event.isChannel);
            } catch (err) {
                console.error('Failed to apply MLS commits', event.contextId, err);
            }
        }));

        // Encryption was switched on or off. Re-reading the state is what stops this client
        // encrypting to a group that has been replaced, or sending plaintext into one that has not.
        this.actionSub.add(this.websocketService.mlsStateChangedObservable.subscribe(async (event) => {
            try {
                await this.mlsSync.refreshState(event.contextId, event.isChannel);
            } catch (err) {
                console.error('Failed to refresh MLS state', event.contextId, err);
            }
        }));
    }

    public logout(): void {
        void this.goToLogin();
    }

    protected openAccountSettings(): void {
        this.quickSettings.openProfileSettings();
    }

    /**
     * Where a clicked household notification lands.
     *
     * <p>Routed on the two ids in the payload rather than on `kind`, deliberately. Every kind names
     * the channel the thing happened in - including `pantry.expiring`, whose `targetId` <i>is</i>
     * that channel - so opening it is right for all seven and for the ones that have not been
     * invented yet. A per-kind ladder would have to grow an entry each time or silently drop the
     * click, which is the failure this one envelope exists to avoid.</p>
     *
     * <p>Falling back to the guild when the channel cannot be resolved is deliberate too: a house
     * whose channel list has not loaded is far better answered by the house than by nothing.</p>
     */
    private openHouseholdTarget(extra: Record<string, string>): void {
        const guild = this.guildService.guilds().find(g => g.id === extra['guildId']);
        if (!guild) return;
        this.navService.selectServer(guild);

        const channel = guild.channels.find(c => c.id === extra['channelId']);
        if (channel) this.navService.openChannel(channel);
        else if (hasHouseholdModule(guild)) this.navService.openHouse(guild.id);
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
            dropTokens: () => this.authService.logout(),
            goToLogin: () => void this.router.navigate(['/authentication']),
        });
    }

    /**
     * Launch sequence, in two halves.
     *
     * <p><b>1. The account's own questions</b> - is the email verified, and what did this account
     * come here for. Both are answered before a byte of MLS work happens, because the second one
     * decides how much of that work is even wanted. It used to run <i>inside</i>
     * {@link runMlsLaunch}, which meant a device with no signing key returned early on
     * `needsRegistration` and never asked at all: the picker turned up only after the user had been
     * walked through registering a device for the messaging half they had not yet said they
     * wanted.</p>
     *
     * <p><b>2. This device's crypto state</b> - unlock, register if genuinely unregistered, then
     * the master-key prompt. Only reached once the first half is settled.</p>
     *
     * <p>The halves are separate methods because the first can suspend: the picker owns the screen
     * and the sequence has nothing left to run, so {@link OnboardingService.pickerCompleted}
     * restarts it at the second half.</p>
     */
    private async initLaunchSequence(): Promise<void> {
        if (!await this.resolveAccountGates()) {
            // A blocking dialog owns the screen. Still mark ready, or it sits behind the splash.
            this.appReady.markReady();
            return;
        }
        await this.runDeviceLaunch();
    }

    /**
     * Answers the account-level questions, and reports whether the launch may continue.
     *
     * <p>False means a blocking dialog now owns the screen. Email verification ends this launch
     * outright; the onboarding picker resumes it through `pickerCompleted`.</p>
     */
    private async resolveAccountGates(): Promise<boolean> {
        let user: UserDto;
        try {
            user = await firstValueFrom(this.userService.getSelf());
        } catch (err) {
            if ((err as {status?: number} | null)?.status === 403) {
                this.emailVerification.show(this.resolveEmail(), {action: 'navigate-login'});
                return false;
            }
            // Not being able to read the account means none of these questions can be answered -
            // but the device half below does not depend on any of them, and refusing to launch over
            // a failed profile fetch would strand the user on a splash screen.
            console.error('Failed to fetch user:', err);
            return true;
        }

        // Before anything reads a device id or opens a store. Every local MLS name is derived from
        // this slot's device id, so a launch that got as far as `runDeviceLaunch` without one would
        // do its work under the bootstrap slot and then find it under a different name next time.
        await this.establishAccountSlot(user);

        if (user.email) this.emailVerification.storeKnownEmail(user.email);
        if (!user.emailVerifiedAt) {
            this.emailVerification.show(user.email || this.resolveEmail());
            return false;
        }
        if (this.onboarding.needsOnboarding()) {
            this.onboarding.show();
            return false;
        }
        return true;
    }

    /**
     * Makes this account's slot live, so the device id and every store named after it resolve to
     * this account rather than to whoever was here last.
     *
     * <p>The display half is filled in afterwards and failing to fetch it is ignored: a switcher
     * row with a blank name is cosmetic, and an account with no slot has no device id at all.</p>
     */
    private async establishAccountSlot(user: UserDto): Promise<void> {
        // Through the switcher rather than the registry directly: a sign-in writes its tokens to
        // the bootstrap slot, because who they belong to is only known here. Moving them onto this
        // slot is part of becoming it.
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
        try {
            await firstValueFrom(this.mlsService.initStorage());
        } catch (storageErr) {
            console.error('MLS state corrupted -wiping and starting fresh:', storageErr);
            await this.wipeLocalMlsState(deviceId);
        }

        // Who the engine is expected to be holding keys for. Read from the slot rather than kept
        // as a field, so the path that resumes here after the onboarding picker has it too.
        const expectedUserId = (await this.accounts.activeSlot())?.userId;

        const outcome = await runMlsLaunch({
            unlock: () => firstValueFrom(this.mlsService.autoUnlock(deviceId, expectedUserId)),
            replenish: () => firstValueFrom(this.userService.replenishKeyCount()),
            checkMasterKey: () => this.promptForMasterKeyIfOwed(),
            processWelcomes: () => this.mlsSync.processPendingWelcomes(),
            sweepForAdmission: () => this.sweepForAdmission(),
        });

        if (outcome.handle) this.keyHandle.set(outcome.handle);
        // Genuinely no key stored: registering is the right move. Anything else is not evidence
        // that this device is unregistered, and registering would mint a fresh keypair over live
        // group state - see MlsLaunchOutcome.
        this.showDeviceRegistration.set(outcome.needsRegistration);
        // Surfaced through the same banner as an unreachable key store: both mean "encryption is
        // not available on this launch and registering is not the answer". They are separate
        // outcomes so the log says which, and so neither can be mistaken for `needsRegistration`.
        this.keyUnlockFailed.set(outcome.keyStoreUnreachable || outcome.identityMismatch);
        if (outcome.identityMismatch) {
            console.error(
                'The signing key stored for this device belongs to another account - the account '
                + 'slot resolved to the wrong device id',
            );
        }
        this.keyPackagesFailed.set(outcome.keyPackagesFailed);

        this.appReady.markReady();
    }

    /**
     * Contract Â§B discovery, for conversations.
     *
     * <p>Enumerates this account's conversations and hands them to
     * {@link MlsJoinRequestService.sweepForAdmission}, which decides locally which of them this
     * device is locked out of and asks to be admitted to those. Without it, exclusion is only ever
     * discovered by the user opening an affected conversation and reading a banner - which does
     * nothing for someone who does not know which conversations they are missing from, and nothing
     * at all for the ones they never open.</p>
     *
     * <p><b>Conversations only, deliberately.</b> Â§B's discovery step is written in terms of the
     * conversation list, channels already carry an explicit ask affordance in
     * `ChannelAccessBannerComponent`, and enumerating every channel of every guild at launch is a
     * different order of magnitude of work for a case the user is already given a button for.</p>
     *
     * <p>The page is generous because the filtering is free - every exclusion the sweep makes is a
     * local store read - and the sweep caps the number of contexts it will actually probe.</p>
     */
    private async sweepForAdmission(): Promise<void> {
        const conversations = await firstValueFrom(
            this.conversationService.getConversations(0, MainPageComponent.SWEEP_PAGE_SIZE),
        );

        const outcome = await this.joinRequests.sweepForAdmission(conversations.map(c => ({
            contextId: c.id,
            isChannel: false,
            // Only ever used to decide whether to *ask*. The sweep consults the local encryption
            // floor for the other direction, so a server calling an encrypted conversation
            // plaintext cannot quietly drop it from the candidate set.
            serverSaysEncrypted: c.encryptionState === ConversationEncryption.Encrypted,
        })));

        if (outcome.probed > 0) {
            console.info('MLS admission sweep', outcome);
        }
    }

    /**
     * Retries just the key-package upload, from the strip that reports it failed.
     *
     * <p>Its own action because the consequence is specific and is not "the launch failed": a
     * device with no key package left is reported to everyone else as unreachable, so it is quietly
     * left out of every conversation created from that point on - readable by every other device on
     * the account and not by this one.</p>
     */
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
        await this.initLaunchSequence();
    }

    /**
     * Recovers from a state file this device can no longer read.
     *
     * <p>The signing key is deliberately kept - see {@link SessionTeardownService.wipeEngineState}.
     * The health record is this component's to keep, which is why the teardown reports the
     * server-side reset rather than recording it itself.</p>
     */
    private async wipeLocalMlsState(deviceId: string): Promise<void> {
        const outcome = await this.teardown.wipeEngineState(deviceId);
        this.mlsHealth.clear();

        if (!outcome.keyPackagesReset) {
            // Not fatal to launch, but it does mean this device stays unreachable until the reset
            // succeeds, so it is surfaced rather than swallowed.
            this.mlsHealth.recordFailure(deviceId, false, 'not-admitted',
                new Error('key packages were not reset after a local wipe'));
        }
    }

    /**
     * The master-key half of the launch gates, read from the account already fetched by
     * {@link resolveAccountGates}.
     */
    private promptForMasterKeyIfOwed(): void {
        const user = this.userService.self();
        if (!user) return;

        if (!user.encryptedMasterKey) {
            // Isle-only accounts are let through with no key. Nothing breaks: the master key
            // encrypts the device backup, not the messages, so the only thing they go without is
            // recoverable history - and they have none to recover. The ask comes back the moment
            // they reach for something social.
            if (this.onboarding.wantsSocial()) this.socialGate.promptNow();
            return;
        }
        // Having a master key and being able to *open* it are different questions, and the second
        // one used to go unasked until a restore failed months later.
        void this.checkMasterKeyHealth();
    }

    /**
     * Re-reads the account, then applies the master-key gate.
     *
     * <p>Used after device registration, which can take long enough that the launch-time snapshot
     * of the account is worth refreshing before deciding anything from it.</p>
     */
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
     *
     * Runs on every unlock rather than only after a reset, because the reset may well have happened
     * on another device or in a browser - this client would otherwise never hear about it.
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
