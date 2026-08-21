import {inject, Injectable} from '@angular/core';
import {catchError, firstValueFrom, map, of, Subject, timeout} from 'rxjs';
import {RealtimeConnectionService} from './realtime-connection.service';
import {MlsService} from './mls.service';
import {MlsHealthService} from './mls-health.service';
import {decodeBody} from '../helpers/message-content.helper';
import {NotificationService, NotificationSound} from './notification.service';
import {MessageDto} from '../dtos/response/message.dto';
import {ProfileService} from './profile.service';
import {PrivacySettingsService} from './privacy-settings.service';
import {UserActivityService} from './user-activity.service';
import {VoiceHeartbeatState} from '../models/voice-room';
import {toChannelJoinRequestEvent} from '../dtos/response/guild-channel-events.dto';
import {
    GuildMessageCreatedPayload,
    mapGuildEphemeralMessagePayload,
    mapGuildMessageCreatedPayload,
    mapGuildMessageUpdatedPayload,
} from '../dtos/response/guild-message-events.dto';

/**
 * The guild half of the shared hub: what this client sends to it, and the few pushes that are more
 * than a forward.
 *
 * Everything that only needed forwarding is gone. Subscribe to
 * {@link RealtimeConnectionService.stream} with the event name instead.
 */
@Injectable({
    providedIn: 'root',
})
export class GuildWebsocketService {
    private realtime = inject(RealtimeConnectionService);
    private privacy = inject(PrivacySettingsService);
    private notificationService = inject(NotificationService);
    private profileService = inject(ProfileService);
    private userActivityService = inject(UserActivityService);
    private mlsService = inject(MlsService);
    private mlsHealth = inject(MlsHealthService);

    /** A channel message, checked against this device's encryption floor before it is published. */
    readonly messageObservable = new Subject<MessageDto>();

    /** A channel message was edited. Same event shape a conversation edit produces. */
    readonly messageUpdatedObservable = this.realtime
        .stream('guild.MessageUpdated')
        .pipe(map(mapGuildMessageUpdatedPayload));

    /** A bot reply only this user can see, and which the server never stored. */
    readonly ephemeralMessageObservable = this.realtime
        .stream('guild.EphemeralMessageCreated')
        .pipe(map(mapGuildEphemeralMessagePayload));

    /**
     * A device asked to be admitted to a channel's group. A prompt to re-read the queue over HTTP,
     * never a decision. See {@link toChannelJoinRequestEvent}.
     */
    readonly mlsJoinRequestObservable = this.realtime
        .stream('guild.ChannelMlsJoinRequested')
        .pipe(map(toChannelJoinRequestEvent));

    // See MessagingWebsocketService.notifiedMessageIds: guards against SignalR redelivering
    // 'guild.MessageCreated' after a reconnect and double-firing the sound.
    private readonly notifiedMessageIds = new Set<string>();

    constructor() {
        this.realtime.stream('guild.PresenceChanged').subscribe(d => {
            this.profileService.setOnlineStatus(d.userId, d.status);
            // Kept out of `ProfileService` on purpose: status patches a cached profile and is lost
            // for anyone uncached, which activity cannot afford. See {@link UserActivityService}.
            if (d.activities !== undefined) this.userActivityService.set(d.userId, d.activities);
        });

        // Not logged. The payload carries `content`, so this would print every message body in a
        // plaintext channel to a console that ships in release builds.
        this.realtime.stream('guild.MessageCreated').subscribe(data => {
            void this.publishMessage(data);
        });
    }

    /** Shared connection state, one connection now backs every feature. */
    get connectionState() {
        return this.realtime.connectionState;
    }

    async start(): Promise<void> {
        await this.realtime.start();
    }

    /** Suppressed when the account has turned typing indicators off (T2-18). See the note on the
     * messaging equivalent for why read state is not gated with it. */
    invokeStartTyping(channelId: string): void {
        if (!this.privacy.sendTypingIndicators()) return;
        void this.realtime.invoke('guild.StartTyping', channelId);
    }

    async updateLastReadMessageByChannel(id: string, channelId: string): Promise<void> {
        await this.realtime.invoke('guild.UpdateLastRead', {channelId, id});
    }

    // Voice invoke methods (client → server).

    invokeVoiceMuteChanged(channelId: string, isMuted: boolean): void {
        void this.realtime.invoke('guild.voice.MuteChanged', {channelId, isMuted});
    }

    invokeVoiceDeafenChanged(channelId: string, isDeafened: boolean): void {
        void this.realtime.invoke('guild.voice.DeafenChanged', {channelId, isDeafened});
    }

    invokeVoiceCameraChanged(channelId: string, isCameraOn: boolean): void {
        void this.realtime.invoke('guild.voice.CameraChanged', {channelId, isCameraOn});
    }

    invokeVoiceScreenShareStarted(channelId: string, shareId: string): void {
        void this.realtime.invoke('guild.voice.ScreenShareStarted', {channelId, shareId});
    }

    invokeVoiceScreenShareStopped(channelId: string, shareId: string): void {
        void this.realtime.invoke('guild.voice.ScreenShareStopped', {channelId, shareId});
    }

    /**
     * The state-asserting heartbeat: liveness and the repair channel.
     *
     * Restating what this client believes is what lets the server correct it. The old
     * `guild.voice.Heartbeat` took no arguments, so the server could learn a client was alive but
     * never that it was wrong, and a missed event stayed missed for the whole session.
     *
     * Report honestly. Passing a session id while not publishing makes peers attempt a subscribe
     * that cannot succeed; passing null while publishing has the server tell them to drop us.
     */
    invokeVoiceHeartbeat(channelId: string, state: VoiceHeartbeatState): void {
        void this.realtime.invoke('voice.Heartbeat', 'channel', channelId, state);
    }

    /**
     * This path hardcodes `encryptionState: Plain` and never decrypts. It goes straight into the
     * store, so a channel this device has encrypted would have the server's own bytes rendered
     * under a real member's name regardless of what the conversation path refuses. Marked
     * unverified rather than decrypted: refusing to render is the safe half of the fix.
     */
    private async publishMessage(data: GuildMessageCreatedPayload): Promise<void> {
        let message = mapGuildMessageCreatedPayload(data);

        const contextId = data.channelId ?? data.conversationId;
        if (contextId && (await this.mlsService.getEncryptionFloor(contextId)) !== null) {
            this.mlsHealth.recordFailure(
                contextId,
                !!data.channelId,
                'downgraded',
                `message ${data.messageId} arrived on the guild socket as cleartext in a ` +
                    `context this device has encrypted`,
            );
            message = {...message, undecryptable: true};
        }

        this.messageObservable.next(message);

        const ownId = this.profileService.ownProfile()?.userId;
        const mentions = data.mentions ?? [];
        if (!ownId || !mentions.includes(ownId) || !this.markNotified(data.messageId)) return;

        // Empty rather than decoded when the mapped message came back unverified. A notification
        // body escapes the app entirely, into the OS notification centre, so it is the last place
        // an unauthenticated body should be allowed to surface.
        const body = message.undecryptable ? '' : decodeBody(data.content);
        const sender = await firstValueFrom(
            this.profileService.getByUserId(data.authorId).pipe(
                timeout(5_000),
                catchError(() => of(null)),
            ),
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

    /** Returns false (and skips) if this messageId was already notified. Bounded so long sessions do not leak. */
    private markNotified(messageId: string): boolean {
        if (this.notifiedMessageIds.has(messageId)) return false;
        this.notifiedMessageIds.add(messageId);
        if (this.notifiedMessageIds.size > 200) {
            const oldest = this.notifiedMessageIds.values().next().value;
            if (oldest !== undefined) this.notifiedMessageIds.delete(oldest);
        }
        return true;
    }
}
