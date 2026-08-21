import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {of, throwError} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {GuildVoiceActivityService} from './guild-voice-activity.service';
import {GuildVoiceActivityDto} from '../dtos/response/guild-voice-activity.dto';
import {GuildVoiceService} from './guild-voice.service';
import {FakeRealtimeConnection} from '../testing/fake-realtime-connection';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';

const GUILD = 'guild-1';
const CHANNEL = 'channel-1';

function activity(overrides: Partial<GuildVoiceActivityDto> = {}): GuildVoiceActivityDto {
    return {
        guildId: GUILD,
        participantCount: 1,
        hasStream: false,
        channels: [
            {
                channelId: CHANNEL,
                participantCount: 1,
                userIds: ['user-1'],
                hasStream: false,
                streamerIds: [],
            },
        ],
        ...overrides,
    };
}

function setup(options: {snapshot?: GuildVoiceActivityDto[]; fails?: boolean} = {}) {
    const ws = new FakeRealtimeConnection();
    const guildVoice = {
        getVoiceActivity: vi.fn(() =>
            options.fails ? throwError(() => new Error('offline')) : of(options.snapshot ?? []),
        ),
    };
    const connectionState = ws.connectionState;
    connectionState.set(ConnectionState.Disconnected);

    TestBed.configureTestingModule({
        providers: [
            {provide: GuildVoiceService, useValue: guildVoice},
            {provide: RealtimeConnectionService, useValue: ws},
        ],
    });

    const service = TestBed.inject(GuildVoiceActivityService);
    return {service, ws, guildVoice, connectionState};
}

/** Puts the socket up, which is what triggers the snapshot read. */
function connect(connectionState: ReturnType<typeof signal<ConnectionState>>) {
    connectionState.set(ConnectionState.Connected);
    TestBed.flushEffects();
}

describe('GuildVoiceActivityService', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('knows nothing before the socket is up', () => {
        const {service, guildVoice} = setup();

        expect(service.presence()).toEqual({});
        expect(guildVoice.getVoiceActivity).not.toHaveBeenCalled();
    });

    it('reads the snapshot once connected', () => {
        const {service, connectionState} = setup({snapshot: [activity()]});

        connect(connectionState);

        expect(service.presence()[GUILD]).toEqual({participantCount: 1, hasStream: false});
    });

    it('sums participants across the channels of a guild', () => {
        const {service, connectionState} = setup({
            snapshot: [
                activity({
                    channels: [
                        {
                            channelId: 'c1',
                            participantCount: 2,
                            userIds: ['a', 'b'],
                            hasStream: false,
                            streamerIds: [],
                        },
                        {
                            channelId: 'c2',
                            participantCount: 1,
                            userIds: ['c'],
                            hasStream: false,
                            streamerIds: [],
                        },
                    ],
                }),
            ],
        });

        connect(connectionState);

        expect(service.presence()[GUILD].participantCount).toBe(3);
    });

    it('reports a live stream anywhere in the guild', () => {
        const {service, connectionState} = setup({
            snapshot: [
                activity({
                    channels: [
                        {
                            channelId: CHANNEL,
                            participantCount: 1,
                            userIds: ['a'],
                            hasStream: true,
                            streamerIds: ['a'],
                        },
                    ],
                }),
            ],
        });

        connect(connectionState);

        expect(service.presence()[GUILD].hasStream).toBe(true);
    });

    it('survives a failed read without breaking the rail', () => {
        const {service, connectionState} = setup({fails: true});

        connect(connectionState);

        expect(service.presence()).toEqual({});
    });

    it('counts somebody joining a guild this client has never opened', () => {
        // The point of the indicator: these events reach every member of the guild, looking at it or not.
        const {service, ws, connectionState} = setup();
        connect(connectionState);

        ws.emit('guild.voice.UserJoinedVoice', {userId: 'user-1', channelId: CHANNEL, guildId: GUILD});

        expect(service.presence()[GUILD].participantCount).toBe(1);
    });

    it('counts one person once however many joins arrive for them', () => {
        // A reconnect can redeliver and a rejoin is ordinary: a counter would drift, a set of user ids cannot.
        const {service, ws, connectionState} = setup();
        connect(connectionState);

        ws.emit('guild.voice.UserJoinedVoice', {userId: 'user-1', channelId: CHANNEL, guildId: GUILD});
        ws.emit('guild.voice.UserJoinedVoice', {userId: 'user-1', channelId: CHANNEL, guildId: GUILD});

        expect(service.presence()[GUILD].participantCount).toBe(1);
    });

    it('drops the guild entirely once the last person leaves', () => {
        const {service, ws, connectionState} = setup({snapshot: [activity()]});
        connect(connectionState);

        ws.emit('guild.voice.UserLeftVoice', {userId: 'user-1', channelId: CHANNEL, guildId: GUILD});

        expect(service.presence()[GUILD]).toBeUndefined();
    });

    it('ignores a leave for somebody who was never counted', () => {
        const {service, ws, connectionState} = setup({snapshot: [activity()]});
        connect(connectionState);

        ws.emit('guild.voice.UserLeftVoice', {userId: 'stranger', channelId: CHANNEL, guildId: GUILD});

        expect(service.presence()[GUILD].participantCount).toBe(1);
    });

    it('lights the live marker when somebody starts sharing', () => {
        const {service, ws, connectionState} = setup({snapshot: [activity()]});
        connect(connectionState);

        ws.emit('guild.voice.ScreenShareStarted', {
            userId: 'user-1',
            shareId: 's1',
            trackName: 'screen-1',
            channelId: CHANNEL,
        });

        expect(service.presence()[GUILD].hasStream).toBe(true);
    });

    it('clears it again when the share stops', () => {
        const {service, ws, connectionState} = setup({snapshot: [activity()]});
        connect(connectionState);
        ws.emit('guild.voice.ScreenShareStarted', {
            userId: 'user-1',
            shareId: 's1',
            trackName: 'screen-1',
            channelId: CHANNEL,
        });

        ws.emit('guild.voice.ScreenShareStopped', {shareId: 's1', channelId: CHANNEL});

        expect(service.presence()[GUILD].hasStream).toBe(false);
    });

    it('clears the marker when the streamer leaves without stopping', () => {
        // Closing the app mid-share produces a leave and no stop, so the marker must clear on the leave.
        const {service, ws, connectionState} = setup({
            snapshot: [
                activity({
                    channels: [
                        {
                            channelId: CHANNEL,
                            participantCount: 2,
                            userIds: ['user-1', 'user-2'],
                            hasStream: true,
                            streamerIds: ['user-1'],
                        },
                    ],
                }),
            ],
        });
        connect(connectionState);

        ws.emit('guild.voice.UserLeftVoice', {userId: 'user-1', channelId: CHANNEL, guildId: GUILD});

        expect(service.presence()[GUILD].hasStream).toBe(false);
    });

    it('ignores a share in a channel it has no roster for', () => {
        const {service, ws, connectionState} = setup();
        connect(connectionState);

        ws.emit('guild.voice.ScreenShareStarted', {
            userId: 'x',
            shareId: 's1',
            trackName: 'screen-x',
            channelId: 'unknown',
        });

        expect(service.presence()).toEqual({});
    });

    // ── setStreaming / share-id-precise stop ─────────────────────────────────────
    //
    // `WsVoiceScreenShareStopped` carries a `shareId`, never a `userId`, so a stop must never clear
    // the whole channel's streamer list.

    it('keeps the marker lit when one of two streamers in a channel stops', () => {
        const {service, ws, connectionState} = setup({
            snapshot: [
                activity({
                    channels: [
                        {
                            channelId: CHANNEL,
                            participantCount: 2,
                            userIds: ['user-1', 'user-2'],
                            hasStream: false,
                            streamerIds: [],
                        },
                    ],
                }),
            ],
        });
        connect(connectionState);

        ws.emit('guild.voice.ScreenShareStarted', {
            userId: 'user-1',
            shareId: 's1',
            trackName: 'screen-1',
            channelId: CHANNEL,
        });
        ws.emit('guild.voice.ScreenShareStarted', {
            userId: 'user-2',
            shareId: 's2',
            trackName: 'screen-2',
            channelId: CHANNEL,
        });

        ws.emit('guild.voice.ScreenShareStopped', {shareId: 's1', channelId: CHANNEL});

        // Clearing the whole channel's streamer list would take the marker dark while user-2 is still sharing.
        expect(service.presence()[GUILD].hasStream).toBe(true);
        // And precisely: user-2 is still counted live, user-1 is not.
        expect(service.streamersIn(GUILD, CHANNEL)).toEqual(['user-2']);
        expect(service.isStreaming('user-2')).toBe(true);
        expect(service.isStreaming('user-1')).toBe(false);
    });

    it('is a no-op for a stop naming a share nobody saw start', () => {
        const {service, ws, connectionState} = setup({
            snapshot: [
                activity({
                    channels: [
                        {
                            channelId: CHANNEL,
                            participantCount: 1,
                            userIds: ['user-1'],
                            hasStream: true,
                            streamerIds: ['user-1'],
                        },
                    ],
                }),
            ],
        });
        connect(connectionState);

        // Joined mid-share: the snapshot says user-1 is live, but with no start event there is no shareId to resolve the stop against.
        ws.emit('guild.voice.ScreenShareStopped', {shareId: 'never-seen', channelId: CHANNEL});

        expect(service.presence()[GUILD].hasStream).toBe(true);
    });

    describe('streamersIn / isStreaming / streamingChannelId', () => {
        it('reports nothing before any snapshot or event', () => {
            const {service} = setup();

            expect(service.streamersIn(GUILD, CHANNEL)).toEqual([]);
            expect(service.isStreaming('user-1')).toBe(false);
            expect(service.streamingChannelId(GUILD, 'user-1')).toBeUndefined();
        });

        it('locates the channel a member is live in', () => {
            const {service, ws, connectionState} = setup();
            connect(connectionState);
            ws.emit('guild.voice.UserJoinedVoice', {userId: 'user-1', channelId: CHANNEL, guildId: GUILD});

            ws.emit('guild.voice.ScreenShareStarted', {
                userId: 'user-1',
                shareId: 's1',
                trackName: 'screen-1',
                channelId: CHANNEL,
            });

            expect(service.streamersIn(GUILD, CHANNEL)).toEqual(['user-1']);
            expect(service.isStreaming('user-1')).toBe(true);
            expect(service.streamingChannelId(GUILD, 'user-1')).toBe(CHANNEL);
        });
    });

    describe('streamerWentLive$', () => {
        it('fires once for a new streamer', () => {
            const {service, ws, connectionState} = setup();
            connect(connectionState);
            ws.emit('guild.voice.UserJoinedVoice', {userId: 'user-1', channelId: CHANNEL, guildId: GUILD});

            const seen: {guildId: string; channelId: string; userId: string}[] = [];
            service.streamerWentLive$.subscribe(e => seen.push(e));

            ws.emit('guild.voice.ScreenShareStarted', {
                userId: 'user-1',
                shareId: 's1',
                trackName: 'screen-1',
                channelId: CHANNEL,
            });

            expect(seen).toEqual([{guildId: GUILD, channelId: CHANNEL, userId: 'user-1'}]);
        });

        it('does not fire for a stream already live in the loaded snapshot', () => {
            const {service, connectionState} = setup({
                snapshot: [
                    activity({
                        channels: [
                            {
                                channelId: CHANNEL,
                                participantCount: 1,
                                userIds: ['user-1'],
                                hasStream: true,
                                streamerIds: ['user-1'],
                            },
                        ],
                    }),
                ],
            });

            const seen: unknown[] = [];
            service.streamerWentLive$.subscribe(e => seen.push(e));
            connect(connectionState);

            expect(seen).toEqual([]);
        });

        it('does not fire twice for a start event redelivered on reconnect', () => {
            const {service, ws, connectionState} = setup();
            connect(connectionState);
            ws.emit('guild.voice.UserJoinedVoice', {userId: 'user-1', channelId: CHANNEL, guildId: GUILD});

            const seen: unknown[] = [];
            service.streamerWentLive$.subscribe(e => seen.push(e));

            ws.emit('guild.voice.ScreenShareStarted', {
                userId: 'user-1',
                shareId: 's1',
                trackName: 'screen-1',
                channelId: CHANNEL,
            });
            ws.emit('guild.voice.ScreenShareStarted', {
                userId: 'user-1',
                shareId: 's1',
                trackName: 'screen-1',
                channelId: CHANNEL,
            });

            expect(seen.length).toBe(1);
        });
    });

    it('re-reads the snapshot on reconnect rather than trusting counts from before the gap', () => {
        const {service, guildVoice, connectionState} = setup({snapshot: [activity()]});
        connect(connectionState);

        connectionState.set(ConnectionState.Disconnected);
        TestBed.flushEffects();
        connect(connectionState);

        expect(guildVoice.getVoiceActivity).toHaveBeenCalledTimes(2);
        expect(service.presence()[GUILD].participantCount).toBe(1);
    });
});
