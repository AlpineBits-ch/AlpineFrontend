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
        cooldownEnabled: false, cooldownSeconds: 10, goLiveGuildIds: [],
        ...overrides,
    };
}

function setup(options: {
    goLiveGuildIds?: string[];
    friendIds?: string[];
    joinedChannelId?: string | null;
    ownProfileLoaded?: boolean;
    guilds?: unknown[];
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
                    getCachedByUserId: (userId: string) => ({userName: userId === STREAMER_ID ? 'Streamer' : userId}),
                },
            },
            {provide: GuildService, useValue: {guilds: signal(options.guilds ?? [guild()])}},
            {
                provide: UserSettingsService, useValue: {
                    notificationSettings: signal(notificationSettings({goLiveGuildIds: options.goLiveGuildIds ?? []})),
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

    it('does nothing when the own profile has not loaded yet', () => {
        const {streamerWentLive$, created} = setup({goLiveGuildIds: [GUILD], ownProfileLoaded: false});

        streamerWentLive$.next(live());

        expect(created).toEqual([]);
    });
});
