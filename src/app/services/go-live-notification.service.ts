import {inject, Injectable} from '@angular/core';
import {TranslateService} from '@ngx-translate/core';
import {GuildVoiceActivityService, StreamerWentLive} from './guild-voice-activity.service';
import {VoiceChannelService} from './voice-channel.service';
import {ProfileService} from './profile.service';
import {GuildService} from './guild.service';
import {UserSettingsService} from './user-settings.service';
import {NotificationService, NotificationSound} from './notification.service';
import {RelationshipStore} from '../stores/relationship.store';

/** The `extra.type` a go-live notification's tag carries, and what `main-page.component.ts` reads
 *  back off an activation to know it should navigate to a stream rather than a conversation. */
export const STREAM_LIVE_ACTION_TYPE = 'stream-live';

/**
 * Turns `GuildVoiceActivityService.streamerWentLive$` into an "X is live" OS notification, quiet by default: a guild notifies only once opted in, or when the streamer is a friend.
 * Must be constructed by the shell, because a root service only starts listening once something injects it and this has to cover guilds not opened this session.
 */
@Injectable({providedIn: 'root'})
export class GoLiveNotificationService {
    private guildVoiceActivity = inject(GuildVoiceActivityService);
    private voiceChannel = inject(VoiceChannelService);
    private profileService = inject(ProfileService);
    private guildService = inject(GuildService);
    private userSettings = inject(UserSettingsService);
    private notifications = inject(NotificationService);
    private relationships = inject(RelationshipStore);
    private translate = inject(TranslateService);

    constructor() {
        this.guildVoiceActivity.streamerWentLive$.subscribe(e => this.maybeNotify(e));
    }

    private maybeNotify({guildId, channelId, userId}: StreamerWentLive): void {
        // Never about yourself, checked by identity so a second device does not announce this account.
        const ownId = this.profileService.ownProfile()?.userId;
        if (!ownId || userId === ownId) return;

        // Already watching it happen - the one place a toast would only restate the screen.
        if (this.voiceChannel.joinedChannelId() === channelId) return;

        if (!this.isEnabledFor(guildId, userId)) return;

        const guild = this.guildService.guilds().find(g => g.id === guildId);
        if (!guild) return;

        const channel = guild.channels.find(c => c.id === channelId);
        // Falls back to the translated placeholder, never the raw id: an uncached streamer is the common case here.
        const streamerName = this.profileService.getCachedByUserId(userId)?.userName
            ?? this.translate.instant('CALL.UNKNOWN_VIEWER');

        void this.notifications.createNotification({
            title: this.translate.instant('CALL.WENT_LIVE_TITLE', {name: streamerName}),
            message: this.translate.instant('CALL.WENT_LIVE_BODY', {channel: channel?.name ?? guild.name}),
            sound: NotificationSound.None,
            actionTypeId: STREAM_LIVE_ACTION_TYPE,
            // Routed by `main-page.component.ts` off `extra.type`. See {@link encodeNotificationTag}.
            extra: {type: STREAM_LIVE_ACTION_TYPE, guildId, channelId, userId},
        }).catch(() => undefined);
    }

    /** Whether this guild, or this particular streamer, may notify. Two independent gates: `goLiveFriendsEnabled` and `goLiveGuildIds` never override each other. */
    private isEnabledFor(guildId: string, streamerUserId: string): boolean {
        const settings = this.userSettings.notificationSettings();
        const isFriend = this.relationships.friends().some(f => f.other.userId === streamerUserId);
        if (isFriend && settings.goLiveFriendsEnabled) return true;
        return settings.goLiveGuildIds.includes(guildId);
    }
}
