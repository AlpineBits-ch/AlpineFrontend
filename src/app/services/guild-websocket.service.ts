import {inject, Injectable, signal} from '@angular/core';
import * as signalR from "@microsoft/signalr";
import {environment} from "../../environments/environment";
import {ConnectionState, ReactionEvent} from "./messaging-websocket.service";
import {OAuthService} from "angular-oauth2-oidc";
import {NotificationService, NotificationSound} from "./notification.service";
import {catchError, firstValueFrom, of, Subject, timeout} from "rxjs";
import {MessageDto} from "../dtos/response/message.dto";
import { MessageEncryptionState } from '../enums/message-encryption-state.enum';
import { MessageType } from '../enums/message-type.enum';
import {AttachmentDto} from "./file.service";
import {ReorderChannesDto} from "../dtos/request/reorder-channel.dto";
import {ProfileService} from "./profile.service";

export interface ChannelTypingEvent {
  channelId: string;
  userId: string;
}

// ── Guild voice events (server → client) ─────────────────────────────────────

export interface WsUserJoinedVoice        { userId: string; channelId: string; guildId: string; }
export interface WsUserLeftVoice          { userId: string; channelId: string; guildId: string; }
export interface WsGuildParticipantJoined { userId: string; cfSessionId: string; audioTrackName: string; channelId: string; }
export interface WsGuildTrackPublished    { userId: string; cfSessionId: string; trackName: string; kind: 'video' | 'screen' | 'screenAudio'; shareId?: string; channelId: string; }
export interface WsGuildTrackClosed      { userId: string; trackName: string; channelId: string; }
export interface WsVoiceMuteChanged      { userId: string; isMuted: boolean; channelId: string; serverForced: boolean; }
export interface WsVoiceDeafenChanged    { userId: string; isDeafened: boolean; channelId: string; serverForced: boolean; }
export interface WsVoiceCameraChanged    { userId: string; isCameraOn: boolean; channelId: string; }
export interface WsVoiceScreenShareStarted { userId: string; shareId: string; trackName: string; channelId: string; }
export interface WsVoiceScreenShareStopped { shareId: string; channelId: string; }
export interface WsMovedToChannel        { channelId: string; guildId: string; movedBy: string; }

export interface WsChannelCreated  { channelId: string; guildId: string; }
export interface WsChannelDeleted  { channelId: string; guildId: string; }
export interface WsCategoryCreated { categoryId: string; guildId: string; }
export interface WsCategoryDeleted { categoryId: string; guildId: string; }

export interface WsWikiPageCreated     { pageId: string; guildId: string; }
export interface WsWikiPageUpdated     { pageId: string; guildId: string; }
export interface WsWikiPageDeleted     { pageId: string; guildId: string; }
export interface WsWikiCategoryCreated { categoryId: string; guildId: string; }
export interface WsWikiCategoryUpdated { categoryId: string; guildId: string; }
export interface WsWikiCategoryDeleted { categoryId: string; guildId: string; }

@Injectable({
  providedIn: 'root',
})
export class GuildWebsocketService {
  private hubConnection: signalR.HubConnection;
  private oAuthService = inject(OAuthService);
  private notificationService = inject(NotificationService);
  private profileService = inject(ProfileService);

  public connectionState = signal(ConnectionState.Disconnected);
  public messageObservable = new Subject<MessageDto>();
  public channelReorderedObservable = new Subject<ReorderChannesDto>();
  public userTypingObservable = new Subject<ChannelTypingEvent>();

  // ── Voice observables ───────────────────────────────────────────────────────
  public userJoinedVoiceObservable         = new Subject<WsUserJoinedVoice>();
  public userLeftVoiceObservable           = new Subject<WsUserLeftVoice>();
  public guildParticipantJoinedObservable  = new Subject<WsGuildParticipantJoined>();
  public guildTrackPublishedObservable     = new Subject<WsGuildTrackPublished>();
  public guildTrackClosedObservable        = new Subject<WsGuildTrackClosed>();
  public voiceMuteChangedObservable        = new Subject<WsVoiceMuteChanged>();
  public voiceDeafenChangedObservable      = new Subject<WsVoiceDeafenChanged>();
  public voiceCameraChangedObservable      = new Subject<WsVoiceCameraChanged>();
  public voiceScreenShareStartedObservable = new Subject<WsVoiceScreenShareStarted>();
  public voiceScreenShareStoppedObservable = new Subject<WsVoiceScreenShareStopped>();
  public movedToChannelObservable          = new Subject<WsMovedToChannel>();

  // ── Channel/category lifecycle ──────────────────────────────────────────────
  public channelCreatedObservable  = new Subject<WsChannelCreated>();
  public channelDeletedObservable  = new Subject<WsChannelDeleted>();
  public categoryCreatedObservable = new Subject<WsCategoryCreated>();
  public categoryDeletedObservable = new Subject<WsCategoryDeleted>();

  // ── Wiki lifecycle ──────────────────────────────────────────────────────────
  public wikiPageCreatedObservable     = new Subject<WsWikiPageCreated>();
  public wikiPageUpdatedObservable     = new Subject<WsWikiPageUpdated>();
  public wikiPageDeletedObservable     = new Subject<WsWikiPageDeleted>();
  public wikiCategoryCreatedObservable = new Subject<WsWikiCategoryCreated>();
  public wikiCategoryUpdatedObservable = new Subject<WsWikiCategoryUpdated>();
  public wikiCategoryDeletedObservable = new Subject<WsWikiCategoryDeleted>();

  // ── Reactions ───────────────────────────────────────────────────────────────
  public reactionAddedObservable  = new Subject<ReactionEvent>();
  public reactionRemovedObservable = new Subject<ReactionEvent>();

  constructor() {
    this.hubConnection = new signalR.HubConnectionBuilder()
        .withUrl(environment.apiUrl + "/api/v1/guild/ws/hubs/guild", {
          accessTokenFactory: () => this.oAuthService.getAccessToken(),
        })
        .withAutomaticReconnect({
          nextRetryDelayInMilliseconds: retryContext => {
            // This function runs before every retry attempt
            // Returning 5000 means it will wait 5 seconds every single time
            return 5000;
          }
        })
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

  invokeStartTyping(channelId: string): void {
    if (this.hubConnection.state === signalR.HubConnectionState.Connected) {
      this.hubConnection.invoke('StartTyping', channelId).catch(() => void 0);
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

    this.hubConnection.on('ChannelReordered', (data: ReorderChannesDto) => {
      this.channelReorderedObservable.next(data);
    });

    this.hubConnection.on('UserTyping', (data: ChannelTypingEvent) => {
      this.userTypingObservable.next(data);
    });

    // ── Guild voice presence ────────────────────────────────────────────────
    this.hubConnection.on('UserJoinedVoice',    (d: WsUserJoinedVoice)          => this.userJoinedVoiceObservable.next(d));
    this.hubConnection.on('UserLeftVoice',      (d: WsUserLeftVoice)            => this.userLeftVoiceObservable.next(d));
    this.hubConnection.on('ParticipantJoined',  (d: WsGuildParticipantJoined)   => this.guildParticipantJoinedObservable.next(d));
    this.hubConnection.on('TrackPublished',     (d: WsGuildTrackPublished)      => this.guildTrackPublishedObservable.next(d));
    this.hubConnection.on('TrackClosed',        (d: WsGuildTrackClosed)         => this.guildTrackClosedObservable.next(d));
    this.hubConnection.on('MuteChanged',        (d: WsVoiceMuteChanged)         => this.voiceMuteChangedObservable.next(d));
    this.hubConnection.on('DeafenChanged',      (d: WsVoiceDeafenChanged)       => this.voiceDeafenChangedObservable.next(d));
    this.hubConnection.on('CameraChanged',      (d: WsVoiceCameraChanged)       => this.voiceCameraChangedObservable.next(d));
    this.hubConnection.on('ScreenShareStarted', (d: WsVoiceScreenShareStarted)  => this.voiceScreenShareStartedObservable.next(d));
    this.hubConnection.on('ScreenShareStopped', (d: WsVoiceScreenShareStopped)  => this.voiceScreenShareStoppedObservable.next(d));
    this.hubConnection.on('MovedToChannel',     (d: WsMovedToChannel)           => this.movedToChannelObservable.next(d));
    this.hubConnection.on('ChannelCreated',        (d: WsChannelCreated)           => this.channelCreatedObservable.next(d));
    this.hubConnection.on('ChannelDeleted',        (d: WsChannelDeleted)           => this.channelDeletedObservable.next(d));
    this.hubConnection.on('CategoryCreated',       (d: WsCategoryCreated)          => this.categoryCreatedObservable.next(d));
    this.hubConnection.on('CategoryDeleted',       (d: WsCategoryDeleted)          => this.categoryDeletedObservable.next(d));
    this.hubConnection.on('WikiPageCreated',       (d: WsWikiPageCreated)          => this.wikiPageCreatedObservable.next(d));
    this.hubConnection.on('WikiPageUpdated',       (d: WsWikiPageUpdated)          => this.wikiPageUpdatedObservable.next(d));
    this.hubConnection.on('WikiPageDeleted',       (d: WsWikiPageDeleted)          => this.wikiPageDeletedObservable.next(d));
    this.hubConnection.on('WikiCategoryCreated',   (d: WsWikiCategoryCreated)      => this.wikiCategoryCreatedObservable.next(d));
    this.hubConnection.on('WikiCategoryUpdated',   (d: WsWikiCategoryUpdated)      => this.wikiCategoryUpdatedObservable.next(d));
    this.hubConnection.on('WikiCategoryDeleted',   (d: WsWikiCategoryDeleted)      => this.wikiCategoryDeletedObservable.next(d));

    this.hubConnection.on('ReactionCreated', (d: ReactionEvent) => this.reactionAddedObservable.next(d));
    this.hubConnection.on('ReactionRemoved', (d: ReactionEvent) => this.reactionRemovedObservable.next(d));

    this.hubConnection.on('MessageCreated', async (data: {
      messageId: string;
      content: string;
      authorId: string;
      conversationId: string | undefined;
      channelId: string;
      attachments: AttachmentDto[];
      inReplyTo: string | undefined;
      mentions: string[] | undefined;
    }) => {
      console.log('Guild MessageCreated:', data);
      const mentions = data.mentions ?? [];
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
        mentions,
        encryptionState: MessageEncryptionState.Plain,
        mlsEpoch:        undefined,
        mlsSequenceNumber: undefined,
        senderDeviceId:  undefined,
        type:            MessageType.Message,
      });

      const ownId = this.profileService.ownProfile()?.userId;
      if (ownId && mentions.includes(ownId)) {
        let body: string;
        try {
          const bytes = Uint8Array.from(atob(data.content), c => c.charCodeAt(0));
          body = new TextDecoder().decode(bytes);
        } catch {
          body = data.content;
        }
        const sender = await firstValueFrom(
          this.profileService.getByUserId(data.authorId).pipe(
            timeout(5_000),
            catchError(() => of(null)),
          )
        );
        await this.notificationService.createNotification({
          title: `${sender?.userName ?? 'Someone'} mentioned you`,
          message: body,
          profile: sender ?? undefined,
          sound: NotificationSound.NewMessage,
          category: 'mention',
          extra: { channelId: data.channelId },
        });
      }
    });
  }

  // ── Voice invoke methods (client → server) ───────────────────────────────────

  invokeVoiceMuteChanged(channelId: string, isMuted: boolean): void {
    if (this.hubConnection.state !== signalR.HubConnectionState.Connected) return;
    this.hubConnection.invoke('VoiceMuteChanged', { channelId, isMuted }).catch(() => void 0);
  }

  invokeVoiceDeafenChanged(channelId: string, isDeafened: boolean): void {
    if (this.hubConnection.state !== signalR.HubConnectionState.Connected) return;
    this.hubConnection.invoke('VoiceDeafenChanged', { channelId, isDeafened }).catch(() => void 0);
  }

  invokeVoiceCameraChanged(channelId: string, isCameraOn: boolean): void {
    if (this.hubConnection.state !== signalR.HubConnectionState.Connected) return;
    this.hubConnection.invoke('VoiceCameraChanged', { channelId, isCameraOn }).catch(() => void 0);
  }

  invokeVoiceScreenShareStarted(channelId: string, shareId: string, trackName: string): void {
    if (this.hubConnection.state !== signalR.HubConnectionState.Connected) return;
    this.hubConnection.invoke('VoiceScreenShareStarted', { channelId, shareId, trackName }).catch(() => void 0);
  }

  invokeVoiceScreenShareStopped(channelId: string, shareId: string): void {
    if (this.hubConnection.state !== signalR.HubConnectionState.Connected) return;
    this.hubConnection.invoke('VoiceScreenShareStopped', { channelId, shareId }).catch(() => void 0);
  }

  invokeVoiceHeartbeat(): void {
    if (this.hubConnection.state !== signalR.HubConnectionState.Connected) return;
    this.hubConnection.invoke('VoiceHeartbeat').catch(() => void 0);
  }
}
