import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {of, Subject, throwError} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {GuildVoiceActivityService} from './guild-voice-activity.service';
import {GuildVoiceActivityDto} from '../dtos/response/guild-voice-activity.dto';
import {GuildVoiceService} from './guild-voice.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';

const GUILD = 'guild-1';
const CHANNEL = 'channel-1';

function activity(overrides: Partial<GuildVoiceActivityDto> = {}): GuildVoiceActivityDto {
    return {
        guildId: GUILD,
        participantCount: 1,
        hasStream: false,
        channels: [{
            channelId: CHANNEL,
            participantCount: 1,
            userIds: ['user-1'],
            hasStream: false,
            streamerIds: [],
        }],
        ...overrides,
    };
}

function setup(options: {snapshot?: GuildVoiceActivityDto[]; fails?: boolean} = {}) {
    const ws = {
        userJoinedVoiceObservable: new Subject<{userId: string; channelId: string; guildId: string}>(),
        userLeftVoiceObservable: new Subject<{userId: string; channelId: string; guildId: string}>(),
        voiceScreenShareStartedObservable: new Subject<{userId: string; shareId: string; channelId: string}>(),
        voiceScreenShareStoppedObservable: new Subject<{shareId: string; channelId: string}>(),
    };
    const guildVoice = {
        getVoiceActivity: vi.fn(() => options.fails
            ? throwError(() => new Error('offline'))
            : of(options.snapshot ?? [])),
    };
    const connectionState = signal(ConnectionState.Disconnected);

    TestBed.configureTestingModule({
        providers: [
            {provide: GuildWebsocketService, useValue: ws},
            {provide: GuildVoiceService, useValue: guildVoice},
            {provide: RealtimeConnectionService, useValue: {connectionState}},
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
            snapshot: [activity({
                channels: [
                    {channelId: 'c1', participantCount: 2, userIds: ['a', 'b'], hasStream: false, streamerIds: []},
                    {channelId: 'c2', participantCount: 1, userIds: ['c'], hasStream: false, streamerIds: []},
                ],
            })],
        });

        connect(connectionState);

        expect(service.presence()[GUILD].participantCount).toBe(3);
    });

    it('reports a live stream anywhere in the guild', () => {
        const {service, connectionState} = setup({
            snapshot: [activity({
                channels: [{
                    channelId: CHANNEL, participantCount: 1, userIds: ['a'],
                    hasStream: true, streamerIds: ['a'],
                }],
            })],
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
        // The point of the indicator: these events reach every member of the guild, whether or not
        // they are looking at it.
        const {service, ws, connectionState} = setup();
        connect(connectionState);

        ws.userJoinedVoiceObservable.next({userId: 'user-1', channelId: CHANNEL, guildId: GUILD});

        expect(service.presence()[GUILD].participantCount).toBe(1);
    });

    it('counts one person once however many joins arrive for them', () => {
        // A reconnect can redeliver, and a rejoin is an ordinary thing to do. A counter would
        // drift; a set of user ids cannot.
        const {service, ws, connectionState} = setup();
        connect(connectionState);

        ws.userJoinedVoiceObservable.next({userId: 'user-1', channelId: CHANNEL, guildId: GUILD});
        ws.userJoinedVoiceObservable.next({userId: 'user-1', channelId: CHANNEL, guildId: GUILD});

        expect(service.presence()[GUILD].participantCount).toBe(1);
    });

    it('drops the guild entirely once the last person leaves', () => {
        const {service, ws, connectionState} = setup({snapshot: [activity()]});
        connect(connectionState);

        ws.userLeftVoiceObservable.next({userId: 'user-1', channelId: CHANNEL, guildId: GUILD});

        expect(service.presence()[GUILD]).toBeUndefined();
    });

    it('ignores a leave for somebody who was never counted', () => {
        const {service, ws, connectionState} = setup({snapshot: [activity()]});
        connect(connectionState);

        ws.userLeftVoiceObservable.next({userId: 'stranger', channelId: CHANNEL, guildId: GUILD});

        expect(service.presence()[GUILD].participantCount).toBe(1);
    });

    it('lights the live marker when somebody starts sharing', () => {
        const {service, ws, connectionState} = setup({snapshot: [activity()]});
        connect(connectionState);

        ws.voiceScreenShareStartedObservable.next({userId: 'user-1', shareId: 's1', channelId: CHANNEL});

        expect(service.presence()[GUILD].hasStream).toBe(true);
    });

    it('clears it again when the share stops', () => {
        const {service, ws, connectionState} = setup({snapshot: [activity()]});
        connect(connectionState);
        ws.voiceScreenShareStartedObservable.next({userId: 'user-1', shareId: 's1', channelId: CHANNEL});

        ws.voiceScreenShareStoppedObservable.next({shareId: 's1', channelId: CHANNEL});

        expect(service.presence()[GUILD].hasStream).toBe(false);
    });

    it('clears the marker when the streamer leaves without stopping', () => {
        // Closing the app mid-share produces a leave and no stop. A "live" dot for a stream that
        // ended is the failure worth avoiding here.
        const {service, ws, connectionState} = setup({
            snapshot: [activity({
                channels: [{
                    channelId: CHANNEL, participantCount: 2, userIds: ['user-1', 'user-2'],
                    hasStream: true, streamerIds: ['user-1'],
                }],
            })],
        });
        connect(connectionState);

        ws.userLeftVoiceObservable.next({userId: 'user-1', channelId: CHANNEL, guildId: GUILD});

        expect(service.presence()[GUILD].hasStream).toBe(false);
    });

    it('ignores a share in a channel it has no roster for', () => {
        const {service, ws, connectionState} = setup();
        connect(connectionState);

        ws.voiceScreenShareStartedObservable.next({userId: 'x', shareId: 's1', channelId: 'unknown'});

        expect(service.presence()).toEqual({});
    });

    // ── setStreaming / share-id-precise stop ─────────────────────────────────────
    //
    // Regression coverage for the bug found in Task 11's investigation: `WsVoiceScreenShareStopped`
    // carries a `shareId`, never a `userId`, and the handler used to clear the whole channel's
    // streamer list on every stop. That is wrong the moment two people are streaming in the same
    // channel at once.

    it('keeps the marker lit when one of two streamers in a channel stops', () => {
        const {service, ws, connectionState} = setup({
            snapshot: [activity({
                channels: [{
                    channelId: CHANNEL, participantCount: 2, userIds: ['user-1', 'user-2'],
                    hasStream: false, streamerIds: [],
                }],
            })],
        });
        connect(connectionState);

        ws.voiceScreenShareStartedObservable.next({userId: 'user-1', shareId: 's1', channelId: CHANNEL});
        ws.voiceScreenShareStartedObservable.next({userId: 'user-2', shareId: 's2', channelId: CHANNEL});

        ws.voiceScreenShareStoppedObservable.next({shareId: 's1', channelId: CHANNEL});

        // Before the fix this cleared the whole channel's streamer list on every stop, so the
        // marker went dark even though user-2 was still sharing.
        expect(service.presence()[GUILD].hasStream).toBe(true);
    });

    it('is a no-op for a stop naming a share nobody saw start', () => {
        const {service, ws, connectionState} = setup({
            snapshot: [activity({
                channels: [{
                    channelId: CHANNEL, participantCount: 1, userIds: ['user-1'],
                    hasStream: true, streamerIds: ['user-1'],
                }],
            })],
        });
        connect(connectionState);

        // Joined mid-share: the snapshot says user-1 is live, but this client never saw the start
        // event, so it has no shareId to resolve the stop against.
        ws.voiceScreenShareStoppedObservable.next({shareId: 'never-seen', channelId: CHANNEL});

        expect(service.presence()[GUILD].hasStream).toBe(true);
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
