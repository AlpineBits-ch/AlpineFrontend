import {inject, Injectable, signal} from '@angular/core';
import * as signalR from '@microsoft/signalr';
import {NotificationService, NotificationSound} from "./notification.service";
import {OAuthService} from "angular-oauth2-oidc";
import {environment} from "../../environments/environment";

export enum ConnectionState {
  Connected,
  Disconnected,
  Connecting,
}
@Injectable({
  providedIn: 'root',
})
export class WebsocketService {
  private hubConnection: signalR.HubConnection;
  private oAuthService = inject(OAuthService);
  private notificationService = inject(NotificationService);

  public connectionState = signal(ConnectionState.Disconnected)
  constructor() {
    this.hubConnection = new signalR.HubConnectionBuilder()
        .withUrl(environment.apiUrl+ "/api/v1/messaging/ws/hubs/messaging", {
          accessTokenFactory: () => this.oAuthService.getAccessToken(),
        })
        .withAutomaticReconnect()
        .build();



  }

  async start(): Promise<void>{
    if(this.hubConnection.state === signalR.HubConnectionState.Connected) return;
    try{
      await this.hubConnection.start();
      this.connectionState.set(ConnectionState.Connected);
      await this.setupListeners();
    }catch (err){
      console.error('Error while starting connection: ', err);
    }
  }

  private async setupListeners(): Promise<void>{
    this.hubConnection.on('FriendRequestAccepted', async (data: {acceptantUserName: string}) => {
      console.log('Friend request accepted:', data);
      await this.notificationService.createNotification({
        title: 'Friend request accepted',
        message: `${data.acceptantUserName} has accepted your friend request`,
        icon: 'person_add',
        sound: NotificationSound.NewMessage
      });
    })

    this.hubConnection.onreconnecting(() => {
      this.notificationService.createNotification({
        title: 'Reconnecting',
        message: 'Attempting to reconnect...',
        icon: 'refresh',
        sound: NotificationSound.NewMessage
      })
      this.connectionState.set(ConnectionState.Connecting);
    })

    this.hubConnection.onreconnected(() => {
      this.connectionState.set(ConnectionState.Connected);
    })

  }

}
