import { Component, inject } from '@angular/core';
import { AuthService } from '../../services/auth.service';
import { Router } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { OAuthService } from 'angular-oauth2-oidc';
import { WebsocketService } from '../../services/websocket.service';
import { ActionSidepanelComponent } from './components/action-sidepanel/action-sidepanel.component';
import { ConversationComponent } from './components/conversation/conversation.component';
import { ServerTaskbarComponent } from './components/server-taskbar/server-taskbar.component';
import { ActivityFeedComponent } from './components/activity-feed/activity-feed.component';
import { ConversationInfoPanelComponent } from './components/conversation-info-panel/conversation-info-panel.component';
import { NavigationService } from './navigation.service';

@Component({
  selector: 'app-main-page',
  imports: [
    HomeComponent,
    ActionSidepanelComponent,
    ConversationComponent,
    ServerTaskbarComponent,
    ActivityFeedComponent,
    ConversationInfoPanelComponent,
  ],
  templateUrl: './main-page.component.html',
  styleUrl: './main-page.component.css',
})
export class MainPageComponent {
  protected authService = inject(AuthService);
  protected oAuthService = inject(OAuthService);
  protected navService = inject(NavigationService);

  private websocketService = inject(WebsocketService);
  protected router = inject(Router);

  public logout(): void {
    this.authService.logout();
    this.router.navigate(['/authentication']);
  }

  constructor() {
    void this.websocketService.start();

    this.oAuthService.setupAutomaticSilentRefresh();
    this.oAuthService.events.subscribe(e => {
      if (e.type === 'token_expires') {
        console.log('Token expiring, performing refresh token flow...');
        this.oAuthService.refreshToken().then(r => console.log('Token refreshed successfully!'));
      }
    });
  }
}
