import {inject, Injectable, signal} from '@angular/core';
import * as signalR from "@microsoft/signalr";
import {environment} from "../../environments/environment";
import {ConnectionState} from "./messaging-websocket.service";
import {OAuthService} from "angular-oauth2-oidc";
import {NotificationService, NotificationSound} from "./notification.service";

@Injectable({
  providedIn: 'root',
})
export class GuildWebsocketService {
  private hubConnection: signalR.HubConnection;
  private oAuthService = inject(OAuthService);
  private notificationService = inject(NotificationService);

  public connectionState = signal(ConnectionState.Disconnected)
  constructor() {
    this.hubConnection = new signalR.HubConnectionBuilder()
        .withUrl(environment.apiUrl+ "/api/v1/guild/ws/hubs/guild", {
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

  private async setupListeners(): Promise<void> {
    this.hubConnection.on('FriendRequestAccepted', async (data: { acceptantUserName: string }) => {
      console.log('Friend request accepted:', data);
      await this.notificationService.createNotification({
        title: 'Friend request accepted',
        message: `${data.acceptantUserName} accepted your friend request`,
        sound: NotificationSound.NewMessage,
      });
    })
  }
}
