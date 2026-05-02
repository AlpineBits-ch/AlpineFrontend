import { Component, inject, OnDestroy } from '@angular/core';
import { AuthService } from '../../services/auth.service';
import { Router } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { OAuthService } from 'angular-oauth2-oidc';
import { MessagingWebsocketService } from '../../services/messaging-websocket.service';
import { ActionSidepanelComponent } from './components/action-sidepanel/action-sidepanel.component';
import { ConversationComponent } from './components/conversation/conversation.component';
import { ChannelComponent } from './components/channel/channel.component';
import { ServerTaskbarComponent } from './components/server-taskbar/server-taskbar.component';
import { ActivityFeedComponent } from './components/activity-feed/activity-feed.component';
import { ConversationInfoPanelComponent } from './components/conversation-info-panel/conversation-info-panel.component';
import { NavigationService } from './navigation.service';
import { NotificationService } from '../../services/notification.service';
import { ConversationStore } from '../../stores/conversation.store';
import { Subscription } from 'rxjs';
import { VoiceWebsocketService } from '../../services/voice-websocket.service';
import { ProfileDialogComponent } from '../../components/profile-dialog/profile-dialog.component';
import { ProfileDialogService } from '../../services/profile-dialog.service';
import { QuickSettingsComponent } from './components/quick-settings/quick-settings.component';
import {
  restoreStateCurrent,
  StateFlags,
} from '@tauri-apps/plugin-window-state';
@Component({
  selector: 'app-main-page',
  imports: [
    HomeComponent,
    ActionSidepanelComponent,
    ConversationComponent,
    ChannelComponent,
    ServerTaskbarComponent,
    ActivityFeedComponent,
    ConversationInfoPanelComponent,
    ProfileDialogComponent,
    QuickSettingsComponent,
  ],
  templateUrl: './main-page.component.html',
  styleUrl: './main-page.component.css',
})
export class MainPageComponent implements OnDestroy {
  protected authService = inject(AuthService);
  protected oAuthService = inject(OAuthService);
  protected navService = inject(NavigationService);
  protected profileDialogSvc = inject(ProfileDialogService);

  private websocketService = inject(MessagingWebsocketService);
  private voiceWebsocketService = inject(VoiceWebsocketService);
  private notificationService = inject(NotificationService);
  private conversationStore = inject(ConversationStore);
  protected router = inject(Router);

  private actionSub: Subscription;

  public logout(): void {
    this.authService.logout();
    this.router.navigate(['/authentication']);
  }

  constructor() {
    void this.websocketService.start();
    void this.voiceWebsocketService.start();



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
      // Channel navigation can be wired here when channels are fully implemented
    });
  }

  ngOnDestroy(): void {
    this.actionSub.unsubscribe();
  }
}
