import {Component, inject, signal} from '@angular/core';
import {AuthService} from "../../services/auth.service";
import {Router} from "@angular/router";
import {HomeComponent} from "./pages/home/home.component";
import {OAuthService} from "angular-oauth2-oidc";
import {ConversationService} from "../../services/conversation.service";
import {WebsocketService} from "../../services/websocket.service";
import {ConversationListComponent} from "./components/conversation-list/conversation-list.component";
import {ActionSidepanelComponent} from "./components/action-sidepanel/action-sidepanel.component";
import {ConversationComponent} from "./components/conversation/conversation.component";
import {ConversationDto} from "../../dtos/response/conversation.dto";
@Component({
  selector: 'app-main-page',
  imports: [
    HomeComponent,
    ConversationListComponent,
    ActionSidepanelComponent,
    ConversationComponent
  ],
  templateUrl: './main-page.component.html',
  styleUrl: './main-page.component.css',
})
export class MainPageComponent {
  protected  authService = inject(AuthService);
  protected oAuthService = inject(OAuthService);

  protected isHomeVisible = signal(false);

  public testConversation = signal<ConversationDto | null>(null);

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
      this.testConversation.set(conversations[0]);
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
