import {Component, inject, signal} from '@angular/core';
import {AuthService} from "../../services/auth.service";
import {Router} from "@angular/router";
import {ConversationTaskbarComponent} from "./components/conversation-taskbar/conversation-taskbar.component";
import {HomeComponent} from "./pages/home/home.component";
import * as signalR from '@microsoft/signalr';
import {environment} from "../../../environments/environment";
import {OAuthService} from "angular-oauth2-oidc";
@Component({
  selector: 'app-main-page',
  imports: [
    ConversationTaskbarComponent,
    HomeComponent
  ],
  templateUrl: './main-page.component.html',
  styleUrl: './main-page.component.css',
})
export class MainPageComponent {
  protected  authService = inject(AuthService);
  protected oAuthService = inject(OAuthService);

  protected isHomeVisible = signal(true);

  private hubConnection: signalR.HubConnection;

  protected router = inject(Router);
  public logout(): void {
    this.authService.logout();
    this.router.navigate(['/authentication']);
  }

  constructor() {
    this.hubConnection = new signalR.HubConnectionBuilder()
        .withUrl(environment.apiUrl+ "/api/v1/messaging/ws/hubs/messaging", {
          accessTokenFactory: () => this.oAuthService.getAccessToken(),
        })
        .build();

    this.hubConnection.start().catch(err => console.error('Error while starting connection: ', err));

    if (this.oAuthService.hasValidAccessToken()) {
      this.oAuthService.setupAutomaticSilentRefresh();
    }  }
}
