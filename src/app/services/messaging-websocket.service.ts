import {inject, Injectable, signal} from '@angular/core';
import * as signalR from '@microsoft/signalr';
import { NotificationService, NotificationSound } from "./notification.service";
import {OAuthService} from "angular-oauth2-oidc";
import {environment} from "../../environments/environment";
import {BehaviorSubject, catchError, firstValueFrom, of, Subject, timeout} from "rxjs";
import {MessageDto} from "../dtos/response/message.dto";
import {AttachmentDto} from "./file.service";
import {OnlineStatus} from '../dtos/response/profile.dto';
import {CallDto} from "../dtos/response/call.dto";
import {ProfileService} from "./profile.service";

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

export interface UserTypingEvent {
  conversationId: string;
  userId: string;
}
@Injectable({
  providedIn: 'root',
})
export class MessagingWebsocketService {
  private hubConnection: signalR.HubConnection;
  private oAuthService = inject(OAuthService);
  private notificationService = inject(NotificationService);
  private profileService = inject(ProfileService);

  public messageObservable = new Subject<MessageDto>()
  public messageUpdatedObservable = new Subject<MessageUpdatedEvent>()
  public messageDeletedObservable = new Subject<MessageDeletedEvent>()
  public conversationRemovedObservable = new Subject<ConversationRemoved>()
  public conversationMemberRemovedObservable = new Subject<ConversationMemberRemoved>()
  public userTypingObservable = new Subject<UserTypingEvent>()

  public userOnlineObservable = new Subject<string>()
  public userOfflineObservable = new Subject<string>()


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

  async updateLastReadMessageByConversation(id: string, conversationId: string){
    if(this.hubConnection.state !== signalR.HubConnectionState.Connected) return;
    await this.hubConnection.invoke('UpdateLastReadMessageByConversation', {conversationId, id})
      .catch(err => console.error('UpdateLastReadMessageByConversation failed:', err));
  }

  private async setupListeners(): Promise<void>{
    this.hubConnection.on('FriendRequestAccepted', async (data: {acceptantUserName: string}) => {
      console.log('Friend request accepted:', data);
      await this.notificationService.createNotification({
        title: 'Friend request accepted',
        message: `${data.acceptantUserName} accepted your friend request`,
        sound: NotificationSound.NewMessage,
      });
    })

    this.hubConnection.on('MessageUpdated', async (data: MessageUpdatedEvent) => {
      console.log('Message updated:', data);
      this.messageUpdatedObservable.next(data);
    })

    this.hubConnection.on('MessageDeleted', async (data: MessageDeletedEvent) => {
      console.log('Message deleted:', data);
      this.messageDeletedObservable.next(data);
    })

    this.hubConnection.on('ConversationDeleted', async (data: ConversationRemoved) => {
      console.log('Conversation removed:', data);
      this.conversationRemovedObservable.next(data);
    })
    this.hubConnection.on('MemberLeft', async (data: ConversationMemberRemoved) => {
      console.log('Conversation member removed:', data);
      this.conversationMemberRemovedObservable.next(data);
    })

    this.hubConnection.on('UserTyping', (data: UserTypingEvent) => {
      this.userTypingObservable.next(data);
    })

    this.hubConnection.on('UserOnline', async (str: string) => {
      this.userOnlineObservable.next(str);
      this.profileService.setOnlineStatus(str, OnlineStatus.Online);
    })

    this.hubConnection.on('UserOffline', async (str: string) => {
      this.userOfflineObservable.next(str);
      this.profileService.setOnlineStatus(str, OnlineStatus.Offline);
    })


    this.hubConnection.on('MessageCreated', async (data: {messageId: string, content: string, authorId: string, conversationId: string, channelId: string | undefined, attachments: AttachmentDto[], inReplyTo: string | undefined, mentions: string[] | undefined}) => {
      console.log('Message created:', data);

      let body: string;
      try {
        const bytes = Uint8Array.from(atob(data.content), c => c.charCodeAt(0));
        body = new TextDecoder().decode(bytes);
      } catch {
        body = data.content;
      }

      const extra: Record<string, string> = {};
      if (data.conversationId) extra['conversationId'] = data.conversationId;
      if (data.channelId) extra['channelId'] = data.channelId;

      // Emit the message first so the UI updates immediately, regardless of notification delays.
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
        mentions: data.mentions ?? [],
      });

      const sender = await firstValueFrom(
        this.profileService.getByUserId(data.authorId).pipe(
          timeout(5_000),
          catchError(() => of(null)),
        )
      );
      await this.notificationService.createNotification({
        title: sender?.userName ?? 'New message',
        message: body,
        profile: sender ?? undefined,
        sound: NotificationSound.NewMessage,
        actionTypeId: 'message',
        extra,
      });
    })

    this.hubConnection.onreconnecting(() => {
      this.notificationService.createNotification({
        title: 'Reconnecting',
        message: 'Attempting to reconnect...',
        sound: NotificationSound.NewMessage,
      })
      this.connectionState.set(ConnectionState.Connecting);
    })

    this.hubConnection.onreconnected(() => {
      this.connectionState.set(ConnectionState.Connected);
    })

  }

  invokeStartTyping(conversationId: string): void {
    if (this.hubConnection.state === signalR.HubConnectionState.Connected) {
      this.hubConnection.invoke('StartTyping', conversationId).catch(() => void 0);
    }
  }

}
