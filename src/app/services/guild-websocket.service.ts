import {inject, Injectable, signal} from '@angular/core';
import * as signalR from "@microsoft/signalr";
import {environment} from "../../environments/environment";
import {ConnectionState} from "./messaging-websocket.service";
import {OAuthService} from "angular-oauth2-oidc";
import {NotificationService, NotificationSound} from "./notification.service";
import {Subject} from "rxjs";
import {MessageDto} from "../dtos/response/message.dto";
import {AttachmentDto} from "./file.service";

@Injectable({
  providedIn: 'root',
})
export class GuildWebsocketService {
  private hubConnection: signalR.HubConnection;
  private oAuthService = inject(OAuthService);
  private notificationService = inject(NotificationService);

  public connectionState = signal(ConnectionState.Disconnected);
  public messageObservable = new Subject<MessageDto>();

  constructor() {
    this.hubConnection = new signalR.HubConnectionBuilder()
        .withUrl(environment.apiUrl + "/api/v1/guild/ws/hubs/guild", {
          accessTokenFactory: () => this.oAuthService.getAccessToken(),
        })
        .withAutomaticReconnect()
        .build();
  }

  async start(): Promise<void> {
    if (this.hubConnection.state === signalR.HubConnectionState.Connected) return;
    try {
      await this.hubConnection.start();
      this.connectionState.set(ConnectionState.Connected);
      await this.setupListeners();
    } catch (err) {
      console.error('Error while starting connection: ', err);
    }
  }

  async updateLastReadMessageByChannel(id: string, channelId: string): Promise<void> {
    if (this.hubConnection.state !== signalR.HubConnectionState.Connected) return;
    await this.hubConnection.invoke('UpdateLastReadMessageByChannel', {channelId, id})
      .catch(err => console.error('UpdateLastReadMessageByChannel failed:', err));
  }

  private async setupListeners(): Promise<void> {
    this.hubConnection.on('FriendRequestAccepted', async (data: { acceptantUserName: string }) => {
      console.log('Friend request accepted:', data);
      await this.notificationService.createNotification({
        title: 'Friend request accepted',
        message: `${data.acceptantUserName} accepted your friend request`,
        sound: NotificationSound.NewMessage,
      });
    });

    this.hubConnection.on('MessageCreated', (data: {
      messageId: string;
      content: string;
      authorId: string;
      conversationId: string | undefined;
      channelId: string;
      attachments: AttachmentDto[];
      inReplyTo: string | undefined;
    }) => {
      console.log('Guild MessageCreated:', data);
      this.messageObservable.next({
        id: data.messageId,
        content: data.content,
        authorId: data.authorId,
        conversationId: data.conversationId,
        channelId: data.channelId,
        createdAt: new Date(),
        updatedAt: new Date(),
        isPending: false,
        isFailed: false,
        attachments: data.attachments,
        inReplyTo: data.inReplyTo,
      });
    });
  }
}
