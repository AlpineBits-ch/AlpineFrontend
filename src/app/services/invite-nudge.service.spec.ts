import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {INVITE_NUDGE_DELAY_MS, INVITE_NUDGE_MS, InviteNudgeService} from './invite-nudge.service';
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

    /**
     * Runs out the opening wait, which is where the row appears - see INVITE_NUDGE_DELAY_MS. Every
     * test that expects to see a row goes through this rather than through `join()` alone, so the
     * wait cannot be removed without the suite noticing.
     */
    function settle(): void {
        vi.advanceTimersByTime(INVITE_NUDGE_DELAY_MS);
        TestBed.tick();
    }

    return {service, join, arrive, emptyOut, leave, settle};
}

describe('InviteNudgeService', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        TestBed.resetTestingModule();
    });

    it('raises the row for the channel you just joined', () => {
        const {service, join, settle} = setup();

        join('chan_1');
        settle();

        expect(service.channelId()).toBe('chan_1');
    });

    it('holds the row back until the join has settled', () => {
        const {service, join} = setup();

        join('chan_1');

        // Nothing in the same frame as the join itself, which is the whole point of the wait.
        expect(service.channelId()).toBeNull();
        vi.advanceTimersByTime(INVITE_NUDGE_DELAY_MS - 1);
        expect(service.channelId()).toBeNull();

        vi.advanceTimersByTime(1);
        expect(service.channelId()).toBe('chan_1');
    });

    it('never appears at all when somebody walks in during the wait', () => {
        const {service, join, arrive, settle} = setup();
        join('chan_1');

        arrive('chan_1', 'ada');
        settle();

        // Not raised and then dropped - never raised. A row that flashes for one frame is worse
        // than no row, which is why arm() re-checks the roster when the wait is up.
        expect(service.channelId()).toBeNull();
    });

    it('drops it once somebody else walks in', () => {
        const {service, join, arrive, settle} = setup();
        join('chan_1');
        settle();

        arrive('chan_1', 'ada');

        expect(service.channelId()).toBeNull();
    });

    it('never raises it for a room that already has people in it', () => {
        const {service, join, settle} = setup();

        join('chan_1', ['ada']);
        settle();

        expect(service.channelId()).toBeNull();
    });

    it('drops it after fifteen seconds of being ignored', () => {
        const {service, join, settle} = setup();
        join('chan_1');
        settle();

        vi.advanceTimersByTime(INVITE_NUDGE_MS - 1);
        expect(service.channelId()).toBe('chan_1');

        vi.advanceTimersByTime(1);
        expect(service.channelId()).toBeNull();
    });

    it('counts the fifteen seconds from when the row appears, not from the join', () => {
        const {service, join, settle} = setup();
        join('chan_1');
        settle();

        // The opening wait is not spent out of the row's own time on screen.
        vi.advanceTimersByTime(INVITE_NUDGE_MS - 1);

        expect(service.channelId()).toBe('chan_1');
    });

    it('stops the countdown once the row has been used', () => {
        const {service, join, settle} = setup();
        join('chan_1');
        settle();

        service.keep();
        vi.advanceTimersByTime(INVITE_NUDGE_MS * 4);

        expect(service.channelId()).toBe('chan_1');
    });

    it('still drops a kept row when somebody arrives', () => {
        const {service, join, arrive, settle} = setup();
        join('chan_1');
        settle();
        service.keep();

        arrive('chan_1', 'ada');

        expect(service.channelId()).toBeNull();
    });

    it('takes the row down with the channel when you leave', () => {
        const {service, join, leave, settle} = setup();
        join('chan_1');
        settle();

        leave();

        expect(service.channelId()).toBeNull();
    });

    it('cancels a row that has not appeared yet when you leave during the wait', () => {
        const {service, join, leave, settle} = setup();
        join('chan_1');

        leave();
        settle();

        expect(service.channelId()).toBeNull();
    });

    it('re-arms when you move straight to another empty channel', () => {
        const {service, join, settle} = setup();
        join('chan_1');
        settle();
        vi.advanceTimersByTime(INVITE_NUDGE_MS - 1);

        join('chan_2');
        // The first channel's row goes with the room it belonged to, before the second one's
        // opening wait has even run.
        expect(service.channelId()).toBeNull();
        settle();

        expect(service.channelId()).toBe('chan_2');
        // The first channel's countdown must not take the second one's row down with it.
        vi.advanceTimersByTime(2);
        expect(service.channelId()).toBe('chan_2');
    });

    it('does not raise it again when everybody leaves a room you are already sitting in', () => {
        const {service, join, arrive, emptyOut, settle} = setup();
        join('chan_1');
        settle();
        arrive('chan_1', 'ada');
        expect(service.channelId()).toBeNull();

        // Ada leaves. Being alone is not the trigger - arriving is.
        emptyOut('chan_1');
        settle();

        expect(service.channelId()).toBeNull();
    });
});
