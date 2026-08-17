import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {of, Subject, throwError} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {GuildVoiceService, VoiceStateDto} from './guild-voice.service';
import {VoiceService} from './voice.service';
import {VoiceChannelService} from './voice-channel.service';
import {GuildService} from './guild.service';
import {toOffer, VoiceResumeService} from './voice-resume.service';
import {DeviceIdentityService} from './device-identity.service';
import {OngoingCallDto} from '../dtos/response/ongoing-call.dto';

const SEAT: VoiceStateDto = {
    guildId: 'guild-1',
    channelId: 'chan-1',
    channelName: 'General',
    deviceId: 'device-1',
    joinedAt: '2026-08-16T12:00:00Z',
};

const CALL: OngoingCallDto = {
    callId: 'call-1',
    conversationId: 'conv-1',
    status: 'Connected',
    creatorId: 'them',
    startedAt: '2026-08-16T12:00:00Z',
    connectedUserIds: ['them'],
};

const CHANNEL = {id: 'chan-1', guildId: 'guild-1', name: 'General'};

function setup(
    options: {
        seat?: VoiceStateDto | null;
        call?: OngoingCallDto | null;
        inVoice?: boolean;
        thisDeviceId?: string;
    } = {},
) {
    const order: string[] = [];
    const guildVoice = {
        getVoiceState: vi.fn(() => of(options.seat ?? null)),
        leave: vi.fn(() => {
            order.push('leave');
            return of(undefined);
        }),
    };
    const voice = {
        getActiveCall: vi.fn(() => of(options.call ?? null)),
        acceptCall: vi.fn(() => of({})),
    };
    const voiceChannel = {
        isInVoice: signal(options.inVoice ?? false),
        joinChannel: vi.fn(async () => {
            order.push('join');
            return true;
        }),
    };
    const guilds = {
        getGuild: vi.fn(() => of({id: 'guild-1', name: 'My Guild', channels: [CHANNEL]})),
    };
    const devices = {deviceId: vi.fn(async () => options.thisDeviceId ?? 'device-1')};

    TestBed.configureTestingModule({
        providers: [
            {provide: GuildVoiceService, useValue: guildVoice},
            {provide: VoiceService, useValue: voice},
            {provide: VoiceChannelService, useValue: voiceChannel},
            {provide: GuildService, useValue: guilds},
            {provide: DeviceIdentityService, useValue: devices},
        ],
    });

    return {
        service: TestBed.inject(VoiceResumeService),
        guildVoice,
        voice,
        voiceChannel,
        guilds,
        devices,
        order,
    };
}

describe('what to offer', () => {
    it('offers nothing when the server places us nowhere', () => {
        expect(toOffer(null, null)).toBeNull();
    });

    it('prefers the channel, which is the seat other people can see', () => {
        expect(toOffer(SEAT, CALL)).toEqual({
            kind: 'channel',
            guildId: 'guild-1',
            channelId: 'chan-1',
            channelName: 'General',
            deviceId: 'device-1',
        });
    });

    it('offers a call when there is no channel seat', () => {
        expect(toOffer(null, CALL)).toEqual({kind: 'call', callId: 'call-1', conversationId: 'conv-1'});
    });
});

describe('the launch read', () => {
    it('asks both services and raises the offer', () => {
        const {service, guildVoice, voice} = setup({seat: SEAT});

        service.check();

        expect(guildVoice.getVoiceState).toHaveBeenCalled();
        expect(voice.getActiveCall).toHaveBeenCalled();
        expect(service.offer()?.kind).toBe('channel');
    });

    it('asks once, however many times a launch path runs', () => {
        const {service, guildVoice} = setup({seat: SEAT});

        service.check();
        service.check();

        expect(guildVoice.getVoiceState).toHaveBeenCalledTimes(1);
    });

    it('shows nothing when both answer 204', () => {
        const {service} = setup();

        service.check();

        expect(service.offer()).toBeNull();
    });

    it('still offers the call when the guild read fails', () => {
        // Different services answer these, so an outage in one must not cost the other's answer.
        const {service, guildVoice} = setup({call: CALL});
        guildVoice.getVoiceState.mockReturnValue(throwError(() => new Error('guild is down')));

        service.check();

        expect(service.offer()?.kind).toBe('call');
    });

    it('stays silent while this client is already in voice', () => {
        // Joining from the sidebar before getting round to the banner answers the question by
        // doing, and a second window that is live makes the offer wrong rather than redundant.
        const {service, voiceChannel} = setup({seat: SEAT, inVoice: true});

        service.check();
        expect(service.offer()).toBeNull();

        voiceChannel.isInVoice.set(false);
        expect(service.offer()).not.toBeNull();
    });
});

describe('answering the offer', () => {
    it('releases the seat when declined, rather than leaving it to the sweep', () => {
        const {service, guildVoice} = setup({seat: SEAT});
        service.check();

        service.dismiss();

        expect(guildVoice.leave).toHaveBeenCalledWith('guild-1', 'chan-1');
        expect(service.offer()).toBeNull();
    });

    it('sends no leave for a declined call, which was already hung up', () => {
        const {service, guildVoice, voice} = setup({call: CALL});
        service.check();

        service.dismiss();

        expect(guildVoice.leave).not.toHaveBeenCalled();
        expect(voice.acceptCall).not.toHaveBeenCalled();
        expect(service.offer()).toBeNull();
    });

    it('rejoins a channel through the ordinary authorised join', async () => {
        const {service, voiceChannel, guilds} = setup({seat: SEAT});
        service.check();

        await service.reconnect();

        expect(guilds.getGuild).toHaveBeenCalledWith('guild-1');
        expect(voiceChannel.joinChannel).toHaveBeenCalledWith(CHANNEL, 'My Guild');
        expect(service.offer()).toBeNull();
    });

    it('releases the dead session before taking the seat again', async () => {
        // Joining on top of the old seat leaves everything that session left on the roster: the
        // media session, the track names, the shares nobody closed. Only a leave clears them.
        const {service, guildVoice, order} = setup({seat: SEAT});
        service.check();

        await service.reconnect();

        expect(guildVoice.leave).toHaveBeenCalledWith('guild-1', 'chan-1');
        expect(order).toEqual(['leave', 'join']);
    });

    it('rejoins even when the leave fails', async () => {
        const {service, voiceChannel, guildVoice} = setup({seat: SEAT});
        guildVoice.leave.mockReturnValue(throwError(() => new Error('offline')));
        service.check();

        await service.reconnect();

        expect(voiceChannel.joinChannel).toHaveBeenCalled();
    });

    it('leaves a seat the server records against no device', async () => {
        const {service, guildVoice} = setup({seat: {...SEAT, deviceId: null}});
        service.check();

        await service.reconnect();

        expect(guildVoice.leave).toHaveBeenCalled();
    });

    it('leaves another device in place and lets the join take it over', async () => {
        // A seat held by this user's phone is live, not a ghost. Yanking it removes the phone from
        // the roster with no `KickedByOtherDevice` to tell it; the join transfers it properly.
        const {service, guildVoice, voiceChannel} = setup({seat: SEAT, thisDeviceId: 'device-2'});
        service.check();

        await service.reconnect();

        expect(guildVoice.leave).not.toHaveBeenCalled();
        expect(voiceChannel.joinChannel).toHaveBeenCalled();
    });

    it('sends no leave for a call, which was hung up as the socket dropped', async () => {
        const {service, guildVoice} = setup({call: CALL});
        service.check();

        await service.reconnect();

        expect(guildVoice.leave).not.toHaveBeenCalled();
    });

    it('rejoins a call by accepting it', async () => {
        const {service, voice} = setup({call: CALL});
        service.check();

        await service.reconnect();

        expect(voice.acceptCall).toHaveBeenCalledWith('call-1');
    });

    it('takes the banner down and reports a refused rejoin rather than asking again', async () => {
        // The join path is entitled to refuse - a seat held by somebody since kicked or banned is
        // exactly the one this banner would otherwise hand back - and what the user needs then is
        // that path's own error, not a banner still offering.
        const {service, voiceChannel} = setup({seat: SEAT});
        voiceChannel.joinChannel.mockRejectedValue(new Error('forbidden'));
        const logged = vi.spyOn(console, 'error').mockImplementation(() => void 0);
        service.check();

        await service.reconnect();

        expect(service.offer()).toBeNull();
        expect(logged).toHaveBeenCalled();
        logged.mockRestore();
    });

    it('refuses a second reconnect while one is in flight', async () => {
        const {service, guilds} = setup({seat: SEAT});
        const pending = new Subject<{id: string; name: string; channels: (typeof CHANNEL)[]}>();
        guilds.getGuild.mockReturnValue(pending);
        service.check();

        const first = service.reconnect();
        // Waited for rather than assumed: the seat is released before the guild is read, so the
        // first reconnect is still a few microtasks short of `getGuild` when it returns here.
        await vi.waitFor(() => expect(guilds.getGuild).toHaveBeenCalledTimes(1));
        await service.reconnect();

        expect(guilds.getGuild).toHaveBeenCalledTimes(1);

        pending.next({id: 'guild-1', name: 'My Guild', channels: [CHANNEL]});
        pending.complete();
        await first;
    });
});

describe('busy', () => {
    it('is false once a reconnect settles', async () => {
        const {service} = setup({seat: SEAT});
        service.check();

        await service.reconnect();

        expect(service.busy()).toBe(false);
    });
});
