import { Component, inject, OnDestroy, signal } from '@angular/core';
import { AuthService } from '../../services/auth.service';
import { Router } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { MobileConversationsPageComponent } from './pages/mobile-conversations/mobile-conversations-page.component';
import { OAuthService } from 'angular-oauth2-oidc';
import { MessagingWebsocketService } from '../../services/messaging-websocket.service';
import { ActionSidepanelComponent } from './components/action-sidepanel/action-sidepanel.component';
import { ConversationComponent } from '../messaging/components/conversation/conversation.component';
import { ChannelComponent } from '../guild/components/channel/channel.component';
import { VoiceChannelComponent } from '../guild/components/voice-channel/voice-channel.component';
import { ServerTaskbarComponent } from '../guild/components/server-taskbar/server-taskbar.component';
import { ActivityFeedComponent } from './components/activity-feed/activity-feed.component';
import { ConversationInfoPanelComponent } from '../messaging/components/conversation-info-panel/conversation-info-panel.component';
import { NavigationService } from './navigation.service';
import { NotificationService } from '../../services/notification.service';
import { ConversationStore } from '../../stores/conversation.store';
import { Subscription } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { VoiceWebsocketService } from '../../services/voice-websocket.service';
import { ProfileDialogComponent } from '../../components/profile-dialog/profile-dialog.component';
import { ProfileDialogService } from '../../services/profile-dialog.service';
import { QuickSettingsComponent } from './components/quick-settings/quick-settings.component';
import { VoiceStatusBarComponent } from './components/voice-status-bar/voice-status-bar.component';
import { ChannelType } from '../../dtos/response/guild.dto';
import { GuildMemberListComponent } from '../guild/components/guild-member-list/guild-member-list.component';
import {
  restoreStateCurrent,
  StateFlags,
} from '@tauri-apps/plugin-window-state';
import { UserTokenService } from '../../services/user-token.service';
import { GuildWebsocketService } from '../../services/guild-websocket.service';
import { UserService } from '../../services/user.service';
import { KeySetupDialogComponent } from '../key-setup/key-setup-dialog/key-setup-dialog.component';
import { MlsService } from '../../services/mls.service';
import { DeviceRegistrationModalComponent } from '../device-registration/device-registration-modal/device-registration-modal.component';
import {ConversationService} from "../../services/conversation.service";

@Component({
  selector: 'app-main-page',
  imports: [
    HomeComponent,
    MobileConversationsPageComponent,
    ActionSidepanelComponent,
    ConversationComponent,
    ChannelComponent,
    VoiceChannelComponent,
    ServerTaskbarComponent,
    ActivityFeedComponent,
    ConversationInfoPanelComponent,
    ProfileDialogComponent,
    QuickSettingsComponent,
    VoiceStatusBarComponent,
    GuildMemberListComponent,
    DeviceRegistrationModalComponent,
    KeySetupDialogComponent,
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

  private websocketService = inject(MessagingWebsocketService);
  private voiceWebsocketService = inject(VoiceWebsocketService);
  private guildWebsocketService = inject(GuildWebsocketService);
  private notificationService = inject(NotificationService);
  private conversationStore = inject(ConversationStore);
  private userTokenService = inject(UserTokenService);
  private userService = inject(UserService);
  private mlsService = inject(MlsService);
  private conversationService = inject(ConversationService);

  protected router = inject(Router);
  protected showDeviceRegistration = signal(false);
  protected showKeySetup = signal(false);
  /** Opaque handle for the session-loaded signing key — set after device unlock. */
  protected keyHandle = signal<string | null>(null);

  private actionSub: Subscription;

  public logout(): void {
    this.authService.logout();
    this.router.navigate(['/authentication']);
  }

  constructor() {
    void this.websocketService.start();
    void this.voiceWebsocketService.start();
    void this.guildWebsocketService.start();

    this.userTokenService.ensureTokenRegistered().then();
    void this.initLaunchSequence();

    this.conversationService.getMlsTokensForUserIds(['user_3CtBCfZ94J4djLAaUnEj4bxQcGL']).subscribe(t => {
      console.log('MLS tokens:', t);
    })

    this.oAuthService.setupAutomaticSilentRefresh();
    this.oAuthService.events.subscribe(e => {
      if (e.type === 'token_expires') {
        console.log('Token expiring, performing refresh token flow...');
        this.oAuthService.refreshToken().then(r => console.log('Token refreshed successfully!'));
      }
    });

    this.actionSub = this.notificationService.action$.subscribe(event => {
      const { conversationId } = event.extra;
      if (conversationId) {
        const conv = this.conversationStore.entities().find(c => c.id === conversationId);
        if (conv) this.navService.openConversation(conv);
      }
    });
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
    await firstValueFrom(this.mlsService.initStorage());
    try {
      const handle = await firstValueFrom(this.mlsService.autoUnlock(deviceId));
      await firstValueFrom(this.userService.replenishKeyCount());
      this.keyHandle.set(handle);
      this.checkMasterKey();
      this.conversationService.getPendingWelcomes().subscribe(w => {
        console.log('Pending welcomes:', w);
        for (const welcome of w) {
          this.mlsService.joinGroup(welcome.welcome, handle)
        }
      })

    } catch (err: any) {
      if (err?.kind === 'KeyNotFound') {
        this.showDeviceRegistration.set(true);
      } else {
        this.showDeviceRegistration.set(true);

        console.error('Failed to unlock device keys:', err);
      }
    }
  }

  protected onDeviceRegistered(keyHandle: string): void {
    this.keyHandle.set(keyHandle);
    this.showDeviceRegistration.set(false);
    this.checkMasterKey();
    this.userService.replenishKeyCount().subscribe();
  }

  private checkMasterKey(): void {
    this.userService.getSelf().subscribe({
      next: user => {
        if (!user.encryptedMasterKey) this.showKeySetup.set(true);
      },
      error: err => console.error('Failed to fetch user:', err),
    });
  }

  ngOnDestroy(): void {
    this.actionSub.unsubscribe();
  }
}
