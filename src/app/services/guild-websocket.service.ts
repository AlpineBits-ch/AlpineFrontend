import {inject, Injectable} from '@angular/core';
import {RealtimeConnectionService} from "./realtime-connection.service";
import {ReactionEvent} from "./messaging-websocket.service";
import {NotificationService, NotificationSound} from "./notification.service";
import {catchError, firstValueFrom, of, Subject, timeout} from "rxjs";
import {MessageDto} from "../dtos/response/message.dto";
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';
import {MessageType} from '../enums/message-type.enum';
import {AttachmentDto} from "./file.service";
import {ReorderChannesDto} from "../dtos/request/reorder-channel.dto";
import {ReorderRolesDto} from "../dtos/request/reorder-roles.dto";
import {ProfileService} from "./profile.service";
import {OnlineStatus} from "../dtos/response/profile.dto";

export interface ChannelTypingEvent {
    channelId: string;
    userId: string;
}

// ── Guild voice events (server → client) ─────────────────────────────────────

export interface WsUserJoinedVoice {
    userId: string;
    channelId: string;
    guildId: string;
}

export interface WsUserLeftVoice {
    userId: string;
    channelId: string;
    guildId: string;
}

export interface WsGuildParticipantJoined {
    userId: string;
    cfSessionId: string;
    audioTrackName: string;
    channelId: string;
}

export interface WsGuildTrackPublished {
    userId: string;
    cfSessionId: string;
    trackName: string;
    kind: 'video' | 'screen' | 'screenAudio';
    shareId?: string;
    channelId: string;
}

export interface WsGuildTrackClosed {
    userId: string;
    trackName: string;
    channelId: string;
}

export interface WsVoiceMuteChanged {
    userId: string;
    isMuted: boolean;
    channelId: string;
    serverForced: boolean;
}

export interface WsVoiceDeafenChanged {
    userId: string;
    isDeafened: boolean;
    channelId: string;
    serverForced: boolean;
}

export interface WsVoiceCameraChanged {
    userId: string;
    isCameraOn: boolean;
    channelId: string;
}

export interface WsVoiceScreenShareStarted {
    userId: string;
    shareId: string;
    trackName: string;
    channelId: string;
}

export interface WsVoiceScreenShareStopped {
    shareId: string;
    channelId: string;
}

export interface WsMovedToChannel {
    channelId: string;
    guildId: string;
    movedBy: string;
}

export interface WsChannelCreated {
    channelId: string;
    guildId: string;
}

export interface WsChannelDeleted {
    channelId: string;
    guildId: string;
}

export interface WsCategoryCreated {
    categoryId: string;
    guildId: string;
}

export interface WsCategoryDeleted {
    categoryId: string;
    guildId: string;
}

export interface WsWikiPageCreated {
    pageId: string;
    guildId: string;
}

export interface WsWikiPageUpdated {
    pageId: string;
    guildId: string;
}

export interface WsWikiPageDeleted {
    pageId: string;
    guildId: string;
}

export interface WsWikiCategoryCreated {
    categoryId: string;
    guildId: string;
}

export interface WsWikiCategoryUpdated {
    categoryId: string;
    guildId: string;
}

export interface WsWikiCategoryDeleted {
    categoryId: string;
    guildId: string;
}

export interface WsMemberBanned {
    guildId: string;
    userId: string;
    reason?: string;
}

export interface WsMemberKicked {
    guildId: string;
    userId: string;
}

export interface WsMemberMuted {
    guildId: string;
    userId: string;
    mutedUntil: string;
}

export interface WsMemberUnmuted {
    guildId: string;
    userId: string;
}

export interface WsMemberLeft {
    guildId: string;
    userId: string;
}

export interface WsGuildDeleted {
    guildId: string;
}

export interface WsGuildUpdated {
    guildId: string;
}

export interface WsChannelUpdated {
    channelId: string;
    guildId: string;
}

export interface WsThreadCreated {
    channelId: string;
    parentChannelId: string;
    guildId: string;
}

export interface WsPresenceChanged {
    userId: string;
    guildId: string;
    status: OnlineStatus;
}

export interface WsBotInstalled {
    guildId: string;
    userId: string; // the bot's user id
}

export interface WsBotUninstalled {
    guildId: string;
    userId: string;
}

@Injectable({
    providedIn: 'root',
})
export class GuildWebsocketService {
    public messageObservable = new Subject<MessageDto>();
    public channelReorderedObservable = new Subject<ReorderChannesDto>();
    public userTypingObservable = new Subject<ChannelTypingEvent>();
    // ── Voice observables ───────────────────────────────────────────────────────
    public userJoinedVoiceObservable = new Subject<WsUserJoinedVoice>();
    public userLeftVoiceObservable = new Subject<WsUserLeftVoice>();
    public guildParticipantJoinedObservable = new Subject<WsGuildParticipantJoined>();
    public guildTrackPublishedObservable = new Subject<WsGuildTrackPublished>();
    public guildTrackClosedObservable = new Subject<WsGuildTrackClosed>();
    public voiceMuteChangedObservable = new Subject<WsVoiceMuteChanged>();
    public voiceDeafenChangedObservable = new Subject<WsVoiceDeafenChanged>();
    public voiceCameraChangedObservable = new Subject<WsVoiceCameraChanged>();
    public voiceScreenShareStartedObservable = new Subject<WsVoiceScreenShareStarted>();
    public voiceScreenShareStoppedObservable = new Subject<WsVoiceScreenShareStopped>();
    public movedToChannelObservable = new Subject<WsMovedToChannel>();
    // ── Channel/category lifecycle ──────────────────────────────────────────────
    public channelCreatedObservable = new Subject<WsChannelCreated>();
    public channelDeletedObservable = new Subject<WsChannelDeleted>();
    public categoryCreatedObservable = new Subject<WsCategoryCreated>();
    public categoryDeletedObservable = new Subject<WsCategoryDeleted>();
    // ── Wiki lifecycle ──────────────────────────────────────────────────────────
    public wikiPageCreatedObservable = new Subject<WsWikiPageCreated>();
    public wikiPageUpdatedObservable = new Subject<WsWikiPageUpdated>();
    public wikiPageDeletedObservable = new Subject<WsWikiPageDeleted>();
    public wikiCategoryCreatedObservable = new Subject<WsWikiCategoryCreated>();
    public wikiCategoryUpdatedObservable = new Subject<WsWikiCategoryUpdated>();
    public wikiCategoryDeletedObservable = new Subject<WsWikiCategoryDeleted>();
    // ── Member moderation ──────────────────────────────────────────────────────────
    public memberBannedObservable = new Subject<WsMemberBanned>();
    public memberKickedObservable = new Subject<WsMemberKicked>();
    public memberMutedObservable = new Subject<WsMemberMuted>();
    public memberUnmutedObservable = new Subject<WsMemberUnmuted>();
    public memberLeftObservable = new Subject<WsMemberLeft>();
    // ── Guild lifecycle ────────────────────────────────────────────────────────────
    public guildDeletedObservable = new Subject<WsGuildDeleted>();
    public guildUpdatedObservable = new Subject<WsGuildUpdated>();
    // ── Reactions ───────────────────────────────────────────────────────────────
    public reactionAddedObservable = new Subject<ReactionEvent>();
    public reactionRemovedObservable = new Subject<ReactionEvent>();
    // ── Roles/channels/threads ────────────────────────────────────────────────────
    public rolesReorderedObservable = new Subject<ReorderRolesDto>();
    public channelUpdatedObservable = new Subject<WsChannelUpdated>();
    public threadCreatedObservable = new Subject<WsThreadCreated>();
    // ── Presence ────────────────────────────────────────────────────────────────
    public presenceChangedObservable = new Subject<WsPresenceChanged>();
    // ── Bot lifecycle ──────────────────────────────────────────────────────────
    public botInstalledObservable = new Subject<WsBotInstalled>();
    public botUninstalledObservable = new Subject<WsBotUninstalled>();
    private realtime = inject(RealtimeConnectionService);
    private notificationService = inject(NotificationService);
    private profileService = inject(ProfileService);
    private listenersSetUp = false;

    /** Shared connection state -one connection now backs every feature. */
    get connectionState() {
        return this.realtime.connectionState;
    }

    async start(): Promise<void> {
        if (!this.listenersSetUp) {
            this.listenersSetUp = true;
            this.setupListeners();
        }
        await this.realtime.start();
    }

    invokeStartTyping(channelId: string): void {
        void this.realtime.invoke('guild.StartTyping', channelId);
    }

    async updateLastReadMessageByChannel(id: string, channelId: string): Promise<void> {
        await this.realtime.invoke('guild.UpdateLastRead', {channelId, id});
    }

    invokeVoiceMuteChanged(channelId: string, isMuted: boolean): void {
        void this.realtime.invoke('guild.voice.MuteChanged', {channelId, isMuted});
    }

    // ── Voice invoke methods (client → server) ───────────────────────────────────

    invokeVoiceDeafenChanged(channelId: string, isDeafened: boolean): void {
        void this.realtime.invoke('guild.voice.DeafenChanged', {channelId, isDeafened});
    }

    invokeVoiceCameraChanged(channelId: string, isCameraOn: boolean): void {
        void this.realtime.invoke('guild.voice.CameraChanged', {channelId, isCameraOn});
    }

    invokeVoiceScreenShareStarted(channelId: string, shareId: string, trackName: string): void {
        void this.realtime.invoke('guild.voice.ScreenShareStarted', {channelId, shareId, trackName});
    }

    invokeVoiceScreenShareStopped(channelId: string, shareId: string): void {
        void this.realtime.invoke('guild.voice.ScreenShareStopped', {channelId, shareId});
    }

    invokeVoiceHeartbeat(): void {
        void this.realtime.invoke('guild.voice.Heartbeat');
    }

    private setupListeners(): void {
        // FriendRequestAccepted is handled by MessagingWebsocketService
        // (conversation.FriendRequestAccepted). With a single shared connection it must
        // only be registered once, so the former duplicate handler here is removed.

        this.realtime.on('guild.ChannelReordered', (data: ReorderChannesDto) => {
            this.channelReorderedObservable.next(data);
        });

        this.realtime.on('guild.UserTyping', (data: ChannelTypingEvent) => {
            this.userTypingObservable.next(data);
        });

        // ── Guild voice presence ────────────────────────────────────────────────
        this.realtime.on('guild.voice.UserJoinedVoice', (d: WsUserJoinedVoice) => this.userJoinedVoiceObservable.next(d));
        this.realtime.on('guild.voice.UserLeftVoice', (d: WsUserLeftVoice) => this.userLeftVoiceObservable.next(d));
        this.realtime.on('guild.voice.ParticipantJoined', (d: WsGuildParticipantJoined) => this.guildParticipantJoinedObservable.next(d));
        this.realtime.on('guild.voice.TrackPublished', (d: WsGuildTrackPublished) => this.guildTrackPublishedObservable.next(d));
        this.realtime.on('guild.voice.TrackClosed', (d: WsGuildTrackClosed) => this.guildTrackClosedObservable.next(d));
        this.realtime.on('guild.voice.MuteChanged', (d: WsVoiceMuteChanged) => this.voiceMuteChangedObservable.next(d));
        this.realtime.on('guild.voice.DeafenChanged', (d: WsVoiceDeafenChanged) => this.voiceDeafenChangedObservable.next(d));
        this.realtime.on('guild.voice.CameraChanged', (d: WsVoiceCameraChanged) => this.voiceCameraChangedObservable.next(d));
        this.realtime.on('guild.voice.ScreenShareStarted', (d: WsVoiceScreenShareStarted) => this.voiceScreenShareStartedObservable.next(d));
        this.realtime.on('guild.voice.ScreenShareStopped', (d: WsVoiceScreenShareStopped) => this.voiceScreenShareStoppedObservable.next(d));
        this.realtime.on('guild.voice.MovedToChannel', (d: WsMovedToChannel) => this.movedToChannelObservable.next(d));
        this.realtime.on('guild.ChannelCreated', (d: WsChannelCreated) => this.channelCreatedObservable.next(d));
        this.realtime.on('guild.ChannelDeleted', (d: WsChannelDeleted) => this.channelDeletedObservable.next(d));
        this.realtime.on('guild.CategoryCreated', (d: WsCategoryCreated) => this.categoryCreatedObservable.next(d));
        this.realtime.on('guild.CategoryDeleted', (d: WsCategoryDeleted) => this.categoryDeletedObservable.next(d));
        this.realtime.on('guild.WikiPageCreated', (d: WsWikiPageCreated) => this.wikiPageCreatedObservable.next(d));
        this.realtime.on('guild.WikiPageUpdated', (d: WsWikiPageUpdated) => this.wikiPageUpdatedObservable.next(d));
        this.realtime.on('guild.WikiPageDeleted', (d: WsWikiPageDeleted) => this.wikiPageDeletedObservable.next(d));
        this.realtime.on('guild.WikiCategoryCreated', (d: WsWikiCategoryCreated) => this.wikiCategoryCreatedObservable.next(d));
        this.realtime.on('guild.WikiCategoryUpdated', (d: WsWikiCategoryUpdated) => this.wikiCategoryUpdatedObservable.next(d));
        this.realtime.on('guild.WikiCategoryDeleted', (d: WsWikiCategoryDeleted) => this.wikiCategoryDeletedObservable.next(d));
        this.realtime.on('guild.MemberBanned', (d: WsMemberBanned) => this.memberBannedObservable.next(d));
        this.realtime.on('guild.MemberKicked', (d: WsMemberKicked) => this.memberKickedObservable.next(d));
        this.realtime.on('guild.MemberMuted', (d: WsMemberMuted) => this.memberMutedObservable.next(d));
        this.realtime.on('guild.MemberUnmuted', (d: WsMemberUnmuted) => this.memberUnmutedObservable.next(d));
        this.realtime.on('guild.MemberLeft', (d: WsMemberLeft) => this.memberLeftObservable.next(d));
        this.realtime.on('guild.GuildDeleted', (d: WsGuildDeleted) => this.guildDeletedObservable.next(d));
        this.realtime.on('guild.GuildUpdated', (d: WsGuildUpdated) => this.guildUpdatedObservable.next(d));
        this.realtime.on('guild.RolesReordered', (d: ReorderRolesDto) => this.rolesReorderedObservable.next(d));
        this.realtime.on('guild.ChannelUpdated', (d: WsChannelUpdated) => this.channelUpdatedObservable.next(d));
        this.realtime.on('guild.ThreadCreated', (d: WsThreadCreated) => this.threadCreatedObservable.next(d));

        this.realtime.on('guild.PresenceChanged', (d: WsPresenceChanged) => {
            this.presenceChangedObservable.next(d);
            this.profileService.setOnlineStatus(d.userId, d.status);
        });

        this.realtime.on('guild.ReactionCreated', (d: ReactionEvent) => this.reactionAddedObservable.next(d));
        this.realtime.on('guild.ReactionRemoved', (d: ReactionEvent) => this.reactionRemovedObservable.next(d));

        this.realtime.on('guild.BotInstalled', (d: WsBotInstalled) => this.botInstalledObservable.next(d));
        this.realtime.on('guild.BotUninstalled', (d: WsBotUninstalled) => this.botUninstalledObservable.next(d));

        this.realtime.on('guild.MessageCreated', async (data: {
            messageId: string;
            content: string;
            authorId: string;
            conversationId: string | undefined;
            channelId: string;
            attachments: AttachmentDto[];
            inReplyTo: string | undefined;
            mentions: string[] | undefined;
            embedsJson: string | undefined;
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
                mlsEpoch: undefined,
                mlsSequenceNumber: undefined,
                senderDeviceId: undefined,
                type: MessageType.Message,
                embedsJson: data.embedsJson,
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
                    extra: {channelId: data.channelId},
                });
            }
        });
    }
}
