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
import {ServerTaskbarComponent} from '../guild/components/server-taskbar/server-taskbar.component';
import {ActivityFeedComponent} from './components/activity-feed/activity-feed.component';
import {
    ConversationInfoPanelComponent
} from '../messaging/components/conversation-info-panel/conversation-info-panel.component';
import {NavigationService} from './navigation.service';
import {NotificationService} from '../../services/notification.service';
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
import {DeviceService} from '../../services/device.service';
import {
    DeviceRegistrationModalComponent
} from '../device-registration/device-registration-modal/device-registration-modal.component';
import {ConversationService} from "../../services/conversation.service";
import {RichPresenceService} from "../../services/rich-presence.service";
import {WikiComponent} from '../guild/components/wiki/wiki.component';
import {WikiPanelComponent} from '../guild/components/wiki/wiki-panel/wiki-panel.component';
import {OnboardingGateComponent} from '../guild/components/onboarding-gate/onboarding-gate.component';
import {EventsPanelComponent} from '../guild/components/events-panel/events-panel.component';
import {GuildFeature, guildHasFeature} from '../guild/guild-features';
import {EmailVerificationService} from '../../services/email-verification.service';
import {AppReadyService} from '../../services/app-ready.service';
import {GuildService} from '../../services/guild.service';
import {runMlsLaunch} from './mls-launch';
import {MlsJoinRequestService} from '../../services/mls-join-request.service';
import {ConversationEncryption} from '../../enums/conversation-encryption.enum';
import {AccountOnboardingComponent} from '../onboarding/account-onboarding.component';
import {OnboardingService} from '../../services/onboarding.service';
import {SocialKeyGateService} from '../../services/social-key-gate.service';

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
        WikiPanelComponent,
        OnboardingGateComponent,
        AccountOnboardingComponent,
        EventsPanelComponent,
        ForumPostListComponent,
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
    private conversationStore = inject(ConversationStore);
    private userTokenService = inject(UserTokenService);
    private userService = inject(UserService);
    private mlsService = inject(MlsService);
    private mlsSync = inject(MlsSyncService);
    private mlsHealth = inject(MlsHealthService);
    private masterKeyState = inject(MasterKeyStateService);
    private deviceService = inject(DeviceService);
    private conversationService = inject(ConversationService);
    private richPresenceService = inject(RichPresenceService);
    private emailVerification = inject(EmailVerificationService);
    private appReady = inject(AppReadyService);
    private guildService = inject(GuildService);
    private joinRequests = inject(MlsJoinRequestService);
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
                        this.emailVerification.show(this.resolveEmail(), 'navigate-login');
                    }
                }
            }),
        );

        this.richPresenceService.start();

        effect(() => {
            console.log('current game: ', this.richPresenceService.currentGame())
        });

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
                next: m => {
                    const permissionString = m.roleMembers.reduce((curr, r) => {
                        if (!r.role.permissions) return curr;
                        return curr === '' ? r.role.permissions : `${curr},${r.role.permissions}`;
                    }, m.permissions ?? '');
                    this.eventsMemberPermissions.set(permissionString);
                },
                error: () => this.eventsMemberPermissions.set(''),
            });
        });

        this.actionSub.add(this.notificationService.action$.subscribe(event => {
            const {conversationId} = event.extra;
            if (conversationId) {
                const conv = this.conversationStore.entities().find(c => c.id === conversationId);
                if (conv) this.navService.openConversation(conv);
            }
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
        this.goToLogin();
    }

    protected openAccountSettings(): void {
        this.quickSettings.openProfileSettings();
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

    private goToLogin(): void {
        this.authService.logout();
        void this.router.navigate(['/authentication']);
    }

    /**
     * Launch sequence:
     * 1. Try to auto-unlock signing keys from OS keychain.
     *    - Success → proceed to step 2.
     *    - KeyNotFound → show device registration modal first; step 2 runs after registration.
     * 2. Check if master key is set; show key-setup dialog if not - unless the account said it only
     *    came for Isle voice, in which case the ask is deferred to its first social action.
     */
    private async initLaunchSequence(): Promise<void> {

        const deviceId = await this.mlsService.getOrCreateDeviceIdentifier();
        try {
            await firstValueFrom(this.mlsService.initStorage());
        } catch (storageErr) {
            console.error('MLS state corrupted -wiping and starting fresh:', storageErr);
            await this.wipeLocalMlsState(deviceId);
        }

        const outcome = await runMlsLaunch({
            unlock: () => firstValueFrom(this.mlsService.autoUnlock(deviceId)),
            replenish: () => firstValueFrom(this.userService.replenishKeyCount()),
            checkMasterKey: () => this.checkMasterKey(),
            processWelcomes: () => this.mlsSync.processPendingWelcomes(),
            sweepForAdmission: () => this.sweepForAdmission(),
        });

        if (outcome.handle) this.keyHandle.set(outcome.handle);
        // Genuinely no key stored: registering is the right move. Anything else is not evidence
        // that this device is unregistered, and registering would mint a fresh keypair over live
        // group state - see MlsLaunchOutcome.
        this.showDeviceRegistration.set(outcome.needsRegistration);
        this.keyUnlockFailed.set(outcome.keyStoreUnreachable);
        this.keyPackagesFailed.set(outcome.keyPackagesFailed);

        this.appReady.markReady();
    }

    /**
     * Contract §B discovery, for conversations.
     *
     * <p>Enumerates this account's conversations and hands them to
     * {@link MlsJoinRequestService.sweepForAdmission}, which decides locally which of them this
     * device is locked out of and asks to be admitted to those. Without it, exclusion is only ever
     * discovered by the user opening an affected conversation and reading a banner - which does
     * nothing for someone who does not know which conversations they are missing from, and nothing
     * at all for the ones they never open.</p>
     *
     * <p><b>Conversations only, deliberately.</b> §B's discovery step is written in terms of the
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
     * Clears every trace of local MLS state, and tells the server to do the same with the key
     * packages it is still handing out for this device.
     *
     * That last step is the one that is easy to miss and expensive to omit: the replenish count is
     * derived purely from server rows, while the private init keys live only here. Wiping locally
     * and leaving ~100 unconsumed packages on the server means the server answers "you have
     * plenty", nothing is re-uploaded, and every Welcome sealed to those packages is undecryptable
     * by the very device it was addressed to - silently, and for good.
     */
    private async wipeLocalMlsState(deviceId: string): Promise<void> {
        await firstValueFrom(this.mlsService.clearStorage());
        await this.mlsService.clearGroupRegistry();
        await this.mlsService.clearMessageCache();
        this.mlsHealth.clear();

        try {
            await firstValueFrom(this.deviceService.resetKeyPackages(deviceId));
        } catch (err) {
            // Not fatal to launch, but it does mean this device stays unreachable until the reset
            // succeeds, so it is surfaced rather than swallowed.
            this.mlsHealth.recordFailure(deviceId, false, 'not-admitted', err);
            console.error('Could not reset server-side key packages after a local wipe', err);
        }
    }

    private checkMasterKey(): void {
        this.userService.getSelf().subscribe({
            next: user => {
                if (user.email) this.emailVerification.storeKnownEmail(user.email);
                if (!user.emailVerifiedAt) {
                    this.emailVerification.show(user.email || this.resolveEmail());
                    return;
                }
                // Ordering is load-bearing. After verification, because an account that does not
                // exist yet should not be asked what it wants; before key setup, because the
                // answer is what decides whether key setup happens at all.
                if (this.onboarding.needsOnboarding()) {
                    this.onboarding.show();
                    return;
                }
                if (!user.encryptedMasterKey) {
                    // Isle-only accounts are let through with no key. Nothing breaks: the master
                    // key encrypts the device backup, not the messages, so the only thing they are
                    // going without is recoverable history - and they have none to recover. The
                    // ask comes back the moment they reach for something social.
                    if (this.onboarding.wantsSocial()) this.socialGate.promptNow();
                    return;
                }
                // Having a master key and being able to *open* it are different questions, and the
                // second one used to go unasked until a restore failed months later.
                void this.checkMasterKeyHealth();
            },
            error: err => {
                const status = (err as any)?.status;
                if (status === 403) {
                    this.emailVerification.show(this.resolveEmail(), 'navigate-login');
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
