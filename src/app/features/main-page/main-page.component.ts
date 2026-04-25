import {Component, inject, signal} from '@angular/core';
import {AuthService} from "../../services/auth.service";
import {Router} from "@angular/router";
import {ConversationTaskbarComponent} from "./components/conversation-taskbar/conversation-taskbar.component";
import {HomeComponent} from "./pages/home/home.component";
import * as signalR from '@microsoft/signalr';
import {environment} from "../../../environments/environment";
import {OAuthService} from "angular-oauth2-oidc";
import {NotificationService, NotificationSound} from "../../services/notification.service";
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
  private notificationService = inject(NotificationService);

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
        .withAutomaticReconnect()
        .build();

    this.hubConnection.start().catch(err => console.error('Error while starting connection: ', err));

    this.hubConnection.on('FriendRequestAccepted', (data: {acceptantUserName: string}) => {
      console.log('Friend request accepted:', data);
      this.notificationService.createNotification({
        title: 'Friend request accepted',
        message: `${data.acceptantUserName} has accepted your friend request`,
        icon: 'person_add',
        sound: NotificationSound.NewMessage
      });
    })

    this.oAuthService.setupAutomaticSilentRefresh();
    this.oAuthService.events.subscribe(e => {
      if (e.type === 'token_expires') {
        console.log('Token expiring, performing refresh token flow...');
        this.oAuthService.refreshToken().then(r => console.log('Token refreshed successfully!'));
      }
    });

  }
}
