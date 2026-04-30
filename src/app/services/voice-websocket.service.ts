import {inject, Injectable, signal} from '@angular/core';
import * as signalR from '@microsoft/signalr';
import {NotificationService, NotificationSound} from "./notification.service";
import {OAuthService} from "angular-oauth2-oidc";
import {environment} from "../../environments/environment";
import {BehaviorSubject, Subject} from "rxjs";
import {MessageDto} from "../dtos/response/message.dto";
import {AttachmentDto} from "./file.service";
import {CallDto} from "../dtos/response/call.dto";

export enum ConnectionState {
  Connected,
  Disconnected,
  Connecting,
}

export interface MessageUpdatedEvent {
  messageId: string;
  content: string;
  authorId: string;
  conversationId: string | undefined;
  channelId: string | undefined;
}

export interface ConversationMemberRemoved {
  conversationId: string;
  userId: string;
  hasLeft: boolean;
}
export interface MessageDeletedEvent {
  messageId: string;
  conversationId: string | undefined;
  channelId: string | undefined;
}


export interface ConversationRemoved {
  conversationId: string;
}
@Injectable({
  providedIn: 'root',
})
export class VoiceWebsocketService {
  private hubConnection: signalR.HubConnection;
  private oAuthService = inject(OAuthService);
  private notificationService = inject(NotificationService);




  public incomingCallObservable = new Subject<CallDto>()
  public connectionState = signal(ConnectionState.Disconnected)
  constructor() {
    this.hubConnection = new signalR.HubConnectionBuilder()
        .withUrl(environment.apiUrl+ "/api/v1/messaging/ws/hubs/voice", {
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


    this.hubConnection.on('IncomingCall', async (data: CallDto) => {
      console.log('Incoming call:', data);
      this.incomingCallObservable.next(data);
    })


    this.hubConnection.onreconnecting(() => {
      this.notificationService.createNotification({
        title: 'Reconnecting',
        message: 'Attempting to reconnect...',
        sound: NotificationSound.NewMessage
      })
      this.connectionState.set(ConnectionState.Connecting);
    })

    this.hubConnection.onreconnected(() => {
      this.connectionState.set(ConnectionState.Connected);
    })

  }

}
