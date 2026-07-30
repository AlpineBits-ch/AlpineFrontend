import {Component, effect, HostListener, inject, OnDestroy, signal, ViewChild} from '@angular/core';
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
import {ChannelType} from '../../dtos/response/guild.dto';
import {GuildMemberListComponent} from '../guild/components/guild-member-list/guild-member-list.component';
import {UserTokenService} from '../../services/user-token.service';
import {GuildWebsocketService} from '../../services/guild-websocket.service';
import {UserService} from '../../services/user.service';
import {KeySetupDialogComponent} from '../key-setup/key-setup-dialog/key-setup-dialog.component';
import {MlsService} from '../../services/mls.service';
import {
    DeviceRegistrationModalComponent
} from '../device-registration/device-registration-modal/device-registration-modal.component';
import {ConversationService} from "../../services/conversation.service";
import {RichPresenceService} from "../../services/rich-presence.service";
import {WikiComponent} from '../guild/components/wiki/wiki.component';
import {WikiPanelComponent} from '../guild/components/wiki/wiki-panel/wiki-panel.component';
import {OnboardingGateComponent} from '../guild/components/onboarding-gate/onboarding-gate.component';
import {EmailVerificationService} from '../../services/email-verification.service';
import {AppReadyService} from '../../services/app-ready.service';

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
        WikiComponent,
        WikiPanelComponent,
        OnboardingGateComponent,
    ],
    templateUrl: './main-page.component.html',
    styleUrl: './main-page.component.css',
})
export class MainPageComponent implements OnDestroy {
    protected authService = inject(AuthService);
    protected oAuthService = inject(OAuthService);
    protected navService = inject(NavigationService);
    protected profileDialogSvc = inject(ProfileDialogService);
    protected readonly ChannelType = ChannelType;
    protected router = inject(Router);
    protected showDeviceRegistration = signal(false);
    protected showKeySetup = signal(false);
    @ViewChild(QuickSettingsComponent) private quickSettings!: QuickSettingsComponent;
    /** Opaque handle for the session-loaded signing key -set after device unlock. */
    protected keyHandle = signal<string | null>(null);
    private websocketService = inject(MessagingWebsocketService);
    private voiceWebsocketService = inject(VoiceWebsocketService);
    private guildWebsocketService = inject(GuildWebsocketService);
    private notificationService = inject(NotificationService);
    private conversationStore = inject(ConversationStore);
    private userTokenService = inject(UserTokenService);
    private userService = inject(UserService);
    private mlsService = inject(MlsService);
    private conversationService = inject(ConversationService);
    private richPresenceService = inject(RichPresenceService);
    private emailVerification = inject(EmailVerificationService);
    private appReady = inject(AppReadyService);
    private actionSub = new Subscription();

    constructor() {
        void this.websocketService.start();
        void this.voiceWebsocketService.start();
        void this.guildWebsocketService.start();

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

        this.actionSub.add(this.notificationService.action$.subscribe(event => {
            const {conversationId} = event.extra;
            if (conversationId) {
                const conv = this.conversationStore.entities().find(c => c.id === conversationId);
                if (conv) this.navService.openConversation(conv);
            }
        }));

        this.actionSub.add(this.websocketService.welcomeObservable.subscribe(async (conversationId) => {
            const keyHandle = this.mlsService.keyHandle();
            if (!keyHandle) return;
            try {
                const welcomes = await firstValueFrom(this.conversationService.getPendingWelcomes());
                const match = welcomes.find(w => w.conversationId === conversationId);
                if (match) {
                    this.mlsService.joinGroup(match.welcome, keyHandle).subscribe({
                        next: info => this.mlsService.registerGroupForConversation(match.conversationId, info.groupId),
                        error: err => console.error('Failed to join MLS group from Welcome event', conversationId, err),
                    });
                }
            } catch (err) {
                console.error('Failed to process Welcome event', conversationId, err);
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
     * 2. Check if master key is set; show key-setup dialog if not.
     */
    private async initLaunchSequence(): Promise<void> {

        const deviceId = await this.mlsService.getOrCreateDeviceIdentifier();
        console.log('Device ID:', deviceId);
        try {
            await firstValueFrom(this.mlsService.initStorage());
        } catch (storageErr) {
            console.error('MLS state corrupted -wiping and starting fresh:', storageErr);
            await firstValueFrom(this.mlsService.clearStorage());
            await this.mlsService.clearGroupRegistry();
        }
        try {
            const handle = await firstValueFrom(this.mlsService.autoUnlock(deviceId));
            await firstValueFrom(this.userService.replenishKeyCount());
            this.keyHandle.set(handle);
            this.checkMasterKey();
            this.conversationService.getPendingWelcomes().subscribe(w => {
                for (const welcome of w) {
                    this.mlsService.joinGroup(welcome.welcome, handle).subscribe({
                        next: info => this.mlsService.registerGroupForConversation(welcome.conversationId, info.groupId),
                        error: err => console.error('Failed to join MLS group for conversation', welcome.conversationId, err),
                    });
                }
            })

        } catch (err: any) {
            if (err?.kind === 'KeyNotFound') {
                this.showDeviceRegistration.set(true);
            } else {
                this.showDeviceRegistration.set(true);

                console.error('Failed to unlock device keys:', err);
            }
        } finally {
            this.appReady.markReady();
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
                if (!user.encryptedMasterKey) this.showKeySetup.set(true);
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

    private resolveEmail(): string {
        const known = this.emailVerification.knownEmail();
        if (known) return known;
        const claims = this.oAuthService.getIdentityClaims() as Record<string, unknown> | null;
        return (claims?.['email'] ?? claims?.['sub'] ?? '') as string;
    }
}
