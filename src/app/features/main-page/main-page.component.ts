import {Component, inject, signal} from '@angular/core';
import {AuthService} from "../../services/auth.service";
import {Router} from "@angular/router";
import {HomeComponent} from "./pages/home/home.component";
import {OAuthService} from "angular-oauth2-oidc";
import {ConversationService} from "../../services/conversation.service";
import {WebsocketService} from "../../services/websocket.service";
import {ConversationListComponent} from "./components/conversation-list/conversation-list.component";
import {ActionSidepanelComponent} from "./components/action-sidepanel/action-sidepanel.component";
@Component({
  selector: 'app-main-page',
  imports: [
    HomeComponent,
    ConversationListComponent,
    ActionSidepanelComponent
  ],
  templateUrl: './main-page.component.html',
  styleUrl: './main-page.component.css',
})
export class MainPageComponent {
  protected  authService = inject(AuthService);
  protected oAuthService = inject(OAuthService);

  protected isHomeVisible = signal(true);

  private conversationService = inject(ConversationService);
  private websocketService = inject(WebsocketService);
  protected router = inject(Router);
  public logout(): void {
    this.authService.logout();
    this.router.navigate(['/authentication']);
  }

  constructor() {

    void this.websocketService.start();


    this.conversationService.getConversations(0, 10).subscribe(conversations => {
      console.log('Conversations:', conversations);
    });

    this.oAuthService.setupAutomaticSilentRefresh();
    this.oAuthService.events.subscribe(e => {
      if (e.type === 'token_expires') {
        console.log('Token expiring, performing refresh token flow...');
        this.oAuthService.refreshToken().then(r => console.log('Token refreshed successfully!'));
      }
    });

  }
}
