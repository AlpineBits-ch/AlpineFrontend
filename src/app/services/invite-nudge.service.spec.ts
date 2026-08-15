import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {INVITE_NUDGE_MS, InviteNudgeService} from './invite-nudge.service';
import {VoiceChannelParticipant, VoiceChannelService} from './voice-channel.service';

function participant(userId: string): VoiceChannelParticipant {
    return {
        userId,
        displayName: userId,
        avatarLabel: userId.charAt(0).toUpperCase(),
        isMuted: false,
        isSpeaking: false,
        isCameraOn: false,
        isScreenSharing: false,
        isServerDeafened: false,
        isLocal: userId === 'me',
    };
}

function setup() {
    const joinedChannelId = signal<string | null>(null);
    const channelParticipants = signal(new Map<string, VoiceChannelParticipant[]>());

    TestBed.configureTestingModule({
        providers: [{provide: VoiceChannelService, useValue: {joinedChannelId, channelParticipants}}],
    });

    const service = TestBed.inject(InviteNudgeService);

    /** Puts this client in a channel with the named people also in it. */
    function join(channelId: string, others: string[] = []): void {
        channelParticipants.update(map =>
            new Map(map).set(channelId, [participant('me'), ...others.map(participant)]));
        joinedChannelId.set(channelId);
        TestBed.tick();
    }

    function arrive(channelId: string, userId: string): void {
        channelParticipants.update(map => {
            const next = new Map(map);
            next.set(channelId, [...(next.get(channelId) ?? []), participant(userId)]);
            return next;
        });
        TestBed.tick();
    }

    /** Leaves this client in the channel, on their own again. */
    function emptyOut(channelId: string): void {
        channelParticipants.update(map => new Map(map).set(channelId, [participant('me')]));
        TestBed.tick();
    }

    function leave(): void {
        joinedChannelId.set(null);
        TestBed.tick();
    }

    return {service, join, arrive, emptyOut, leave};
}

describe('InviteNudgeService', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        TestBed.resetTestingModule();
    });

    it('raises the row for the channel you just joined', () => {
        const {service, join} = setup();

        join('chan_1');

        expect(service.channelId()).toBe('chan_1');
    });

    it('drops it once somebody else walks in', () => {
        const {service, join, arrive} = setup();
        join('chan_1');

        arrive('chan_1', 'ada');

        expect(service.channelId()).toBeNull();
    });

    it('never raises it for a room that already has people in it', () => {
        const {service, join} = setup();

        join('chan_1', ['ada']);

        expect(service.channelId()).toBeNull();
    });

    it('drops it after fifteen seconds of being ignored', () => {
        const {service, join} = setup();
        join('chan_1');

        vi.advanceTimersByTime(INVITE_NUDGE_MS - 1);
        expect(service.channelId()).toBe('chan_1');

        vi.advanceTimersByTime(1);
        expect(service.channelId()).toBeNull();
    });

    it('stops the countdown once the row has been used', () => {
        const {service, join} = setup();
        join('chan_1');

        service.keep();
        vi.advanceTimersByTime(INVITE_NUDGE_MS * 4);

        expect(service.channelId()).toBe('chan_1');
    });

    it('still drops a kept row when somebody arrives', () => {
        const {service, join, arrive} = setup();
        join('chan_1');
        service.keep();

        arrive('chan_1', 'ada');

        expect(service.channelId()).toBeNull();
    });

    it('takes the row down with the channel when you leave', () => {
        const {service, join, leave} = setup();
        join('chan_1');

        leave();

        expect(service.channelId()).toBeNull();
    });

    it('re-arms when you move straight to another empty channel', () => {
        const {service, join} = setup();
        join('chan_1');
        vi.advanceTimersByTime(INVITE_NUDGE_MS - 1);

        join('chan_2');

        expect(service.channelId()).toBe('chan_2');
        // The first channel's countdown must not take the second one's row down with it.
        vi.advanceTimersByTime(2);
        expect(service.channelId()).toBe('chan_2');
    });

    it('does not raise it again when everybody leaves a room you are already sitting in', () => {
        const {service, join, arrive, emptyOut} = setup();
        join('chan_1');
        arrive('chan_1', 'ada');
        expect(service.channelId()).toBeNull();

        // Ada leaves. Being alone is not the trigger - arriving is.
        emptyOut('chan_1');

        expect(service.channelId()).toBeNull();
    });
});
