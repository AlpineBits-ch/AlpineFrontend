import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {TranslateService} from '@ngx-translate/core';
import {Subject} from 'rxjs';
import {beforeEach, describe, expect, it} from 'vitest';
import {GoLiveNotificationService, STREAM_LIVE_ACTION_TYPE} from './go-live-notification.service';
import {GuildVoiceActivityService, StreamerWentLive} from './guild-voice-activity.service';
import {VoiceChannelService} from './voice-channel.service';
import {ProfileService} from './profile.service';
import {GuildService} from './guild.service';
import {UserSettingsService, NotificationSettings} from './user-settings.service';
import {NotificationService} from './notification.service';
import {RelationshipStore} from '../stores/relationship.store';

const GUILD = 'guild-1';
const CHANNEL = 'channel-1';
const OWN_USER_ID = 'me';
const STREAMER_ID = 'streamer-1';

function guild(overrides: Partial<{ id: string; name: string; channels: { id: string; name: string }[] }> = {}) {
    return {
        id: GUILD,
        name: 'Test Guild',
        channels: [{id: CHANNEL, name: 'General Voice'}],
        ...overrides,
    } as any;
}

function notificationSettings(overrides: Partial<NotificationSettings> = {}): NotificationSettings {
    return {
        enabled: true, dm: true, mentions: true, sounds: true,
        cooldownEnabled: false, cooldownSeconds: 10, goLiveGuildIds: [], goLiveFriendsEnabled: true,
        ...overrides,
    };
}

function setup(options: {
    goLiveGuildIds?: string[];
    goLiveFriendsEnabled?: boolean;
    friendIds?: string[];
    joinedChannelId?: string | null;
    ownProfileLoaded?: boolean;
    guilds?: unknown[];
    cacheMiss?: boolean;
} = {}) {
    const streamerWentLive$ = new Subject<StreamerWentLive>();
    const created: { title: string; message: string; actionTypeId?: string; extra?: Record<string, string> }[] = [];

    TestBed.configureTestingModule({
        providers: [
            {provide: GuildVoiceActivityService, useValue: {streamerWentLive$}},
            {provide: VoiceChannelService, useValue: {joinedChannelId: signal(options.joinedChannelId ?? null)}},
            {
                provide: ProfileService, useValue: {
                    ownProfile: signal(options.ownProfileLoaded === false ? undefined : {userId: OWN_USER_ID}),
                    getCachedByUserId: (userId: string) =>
                        options.cacheMiss ? undefined : {userName: userId === STREAMER_ID ? 'Streamer' : userId},
                },
            },
            {provide: GuildService, useValue: {guilds: signal(options.guilds ?? [guild()])}},
            {
                provide: UserSettingsService, useValue: {
                    notificationSettings: signal(notificationSettings({
                        goLiveGuildIds: options.goLiveGuildIds ?? [],
                        goLiveFriendsEnabled: options.goLiveFriendsEnabled ?? true,
                    })),
                },
            },
            {
                provide: NotificationService, useValue: {
                    createNotification: (opts: any) => {
                        created.push(opts);
                        return Promise.resolve();
                    },
                },
            },
            {
                provide: RelationshipStore, useValue: {
                    friends: signal((options.friendIds ?? []).map(id => ({other: {userId: id}}))),
                },
            },
            // Echoes the key and its params - deterministic and enough to prove the right strings
            // and placeholders were asked for, without loading real translations.
            {
                provide: TranslateService, useValue: {
                    instant: (key: string, params?: Record<string, unknown>) =>
                        params ? `${key}(${Object.values(params).join(',')})` : key,
                },
            },
        ],
    });

    const service = TestBed.inject(GoLiveNotificationService);
    return {service, streamerWentLive$, created};
}

function live(overrides: Partial<StreamerWentLive> = {}): StreamerWentLive {
    return {guildId: GUILD, channelId: CHANNEL, userId: STREAMER_ID, ...overrides};
}

describe('GoLiveNotificationService', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('notifies once when an opted-in guild gets a new streamer', () => {
        const {streamerWentLive$, created} = setup({goLiveGuildIds: [GUILD]});

        streamerWentLive$.next(live());

        expect(created.length).toBe(1);
        expect(created[0].actionTypeId).toBe(STREAM_LIVE_ACTION_TYPE);
        expect(created[0].extra).toEqual({type: STREAM_LIVE_ACTION_TYPE, guildId: GUILD, channelId: CHANNEL, userId: STREAMER_ID});
        expect(created[0].title).toContain('Streamer');
    });

    it('stays silent for a guild that has not opted in', () => {
        const {streamerWentLive$, created} = setup({goLiveGuildIds: []});

        streamerWentLive$.next(live());

        expect(created).toEqual([]);
    });

    it('notifies for a friend even in a guild that has not opted in', () => {
        const {streamerWentLive$, created} = setup({goLiveGuildIds: [], friendIds: [STREAMER_ID]});

        streamerWentLive$.next(live());

        expect(created.length).toBe(1);
    });

    it('suppresses a friend notification when the friends toggle is off', () => {
        // The failure the reviewer caught: friendship used to override the guild toggle
        // unconditionally, leaving no way to quiet one loud friend short of the master switch.
        const {streamerWentLive$, created} = setup({
            goLiveGuildIds: [], friendIds: [STREAMER_ID], goLiveFriendsEnabled: false,
        });

        streamerWentLive$.next(live());

        expect(created).toEqual([]);
    });

    it('still notifies for a friend whose guild is separately opted in, even with the friends toggle off', () => {
        // The two gates are independent, not one overriding the other.
        const {streamerWentLive$, created} = setup({
            goLiveGuildIds: [GUILD], friendIds: [STREAMER_ID], goLiveFriendsEnabled: false,
        });

        streamerWentLive$.next(live());

        expect(created.length).toBe(1);
    });

    it('suppresses the notification when the user is already in that channel', () => {
        const {streamerWentLive$, created} = setup({goLiveGuildIds: [GUILD], joinedChannelId: CHANNEL});

        streamerWentLive$.next(live());

        expect(created).toEqual([]);
    });

    it('never notifies about your own stream', () => {
        const {streamerWentLive$, created} = setup({goLiveGuildIds: [GUILD]});

        streamerWentLive$.next(live({userId: OWN_USER_ID}));

        expect(created).toEqual([]);
    });

    it('does nothing for a guild this client has not loaded', () => {
        const {streamerWentLive$, created} = setup({goLiveGuildIds: [GUILD], guilds: []});

        streamerWentLive$.next(live());

        expect(created).toEqual([]);
    });

    it('falls back to the translated placeholder, never the raw user id, when the streamer is not cached', () => {
        // The exact defect a parallel worktree already fixed for the DM/voice-channel viewer lists
        // (`CALL.UNKNOWN_VIEWER`) - this is the notification-title instance of the same bug. The
        // uncached case is the common one here: the whole point of this service is notifying about
        // guilds the user has not opened this session, so its member cache is often cold.
        const {streamerWentLive$, created} = setup({goLiveGuildIds: [GUILD], cacheMiss: true});

        streamerWentLive$.next(live());

        expect(created.length).toBe(1);
        expect(created[0].title).toContain('CALL.UNKNOWN_VIEWER');
        expect(created[0].title).not.toContain(STREAMER_ID);
    });

    it('does nothing when the own profile has not loaded yet', () => {
        const {streamerWentLive$, created} = setup({goLiveGuildIds: [GUILD], ownProfileLoaded: false});

        streamerWentLive$.next(live());

        expect(created).toEqual([]);
    });
});
