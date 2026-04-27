import {inject, Injectable, signal} from '@angular/core';
import * as signalR from '@microsoft/signalr';
import {NotificationService, NotificationSound} from "./notification.service";
import {OAuthService} from "angular-oauth2-oidc";
import {environment} from "../../environments/environment";
import {BehaviorSubject, Subject} from "rxjs";
import {MessageDto} from "../dtos/response/message.dto";

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

  public messageObservable = new Subject<MessageDto>()

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

    this.hubConnection.on('MessageCreated', async (data: {messageId: string, content: string, authorId: string, conversationId: string, channelId: string | undefined}) => {
      console.log('Message created:', data);
      await this.notificationService.createNotification({
        title: 'New message',
        message: `${atob(data.content)}`,
        icon: 'message',
        sound: NotificationSound.NewMessage
      });

      this.messageObservable.next({
        id: data.messageId,
        content: data.content,
        authorId: data.authorId,
        conversationId: data.conversationId,
        channelId: data.channelId,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
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
