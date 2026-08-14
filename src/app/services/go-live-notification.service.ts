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
 * Turns `GuildVoiceActivityService.streamerWentLive$` into an "X is live" OS notification.
 *
 * <p>Deliberately quiet by default. An unconditional notification for every guild a member is in
 * would be noise nobody asked for the moment they join a busy server - so a guild only produces
 * one once the user opts it in from notification settings, unless the streamer is someone they
 * are already friends with, where the interesting case is the person rather than the place.</p>
 *
 * <p>Injected once by the shell (`main-page.component.ts`), the same way `HouseholdAlertService`
 * is - a root service only starts listening once something constructs it, and this has to be
 * listening for guilds the user has not opened this session, exactly like the presence rail it
 * reads from.</p>
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
        // Never about yourself - checked by identity rather than by "am I in this channel" alone,
        // so a second device that has not joined the channel locally still knows better than to
        // tell this account it just went live.
        const ownId = this.profileService.ownProfile()?.userId;
        if (!ownId || userId === ownId) return;

        // Already watching it happen - the one place a toast would only restate the screen.
        if (this.voiceChannel.joinedChannelId() === channelId) return;

        if (!this.isEnabledFor(guildId, userId)) return;

        const guild = this.guildService.guilds().find(g => g.id === guildId);
        if (!guild) return;

        const channel = guild.channels.find(c => c.id === channelId);
        const streamerName = this.profileService.getCachedByUserId(userId)?.userName ?? userId;

        void this.notifications.createNotification({
            title: this.translate.instant('CALL.WENT_LIVE_TITLE', {name: streamerName}),
            message: this.translate.instant('CALL.WENT_LIVE_BODY', {channel: channel?.name ?? guild.name}),
            sound: NotificationSound.None,
            actionTypeId: STREAM_LIVE_ACTION_TYPE,
            // Routed by `main-page.component.ts` off `extra.type`, the same convention
            // `openHouseholdTarget` uses - see `encodeNotificationTag` for why the tag is a JSON
            // container rather than a delimited string.
            extra: {type: STREAM_LIVE_ACTION_TYPE, guildId, channelId, userId},
        }).catch(() => undefined);
    }

    /**
     * Whether this guild - or this particular streamer - is allowed to notify.
     *
     * <p>Friendship overrides the guild's own toggle rather than being gated by it: the point of a
     * friend override is that it works the first time someone you know goes live in a guild you
     * have never touched notification settings for.</p>
     */
    private isEnabledFor(guildId: string, streamerUserId: string): boolean {
        const isFriend = this.relationships.friends().some(f => f.other.userId === streamerUserId);
        if (isFriend) return true;
        return this.userSettings.notificationSettings().goLiveGuildIds.includes(guildId);
    }
}
