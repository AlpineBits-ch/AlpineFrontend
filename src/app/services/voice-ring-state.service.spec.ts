import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {provideTranslateService} from '@ngx-translate/core';
import {Subject} from 'rxjs';
import {of, throwError} from 'rxjs';
import {vi} from 'vitest';
import {refusalMessageKey, VoiceRingStateService} from './voice-ring-state.service';
import {VoiceRingService} from './voice-ring.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';
import {DeviceIdentityService} from './device-identity.service';
import {GuildService} from './guild.service';
import {ProfileService} from './profile.service';
import {ToastService} from './toast.service';
import {VoiceChannelService} from './voice-channel.service';
import {ChannelType} from '../dtos/response/guild.dto';
import {
    VoiceRingDto,
    VoiceRingReason,
    VoiceRingRefusalReason,
    VoiceRingStatus,
    WsVoiceRing,
    WsVoiceRingDismissed,
    WsVoiceRingResolved,
} from '../dtos/response/voice-ring.dto';

const OWN_DEVICE = 'device_here';

function ringEvent(overrides: Partial<WsVoiceRing> = {}): WsVoiceRing {
    return {
        ringId: 'ring_1',
        guildId: 'g1',
        channelId: 'chan_1',
        channelName: 'General',
        inviterId: 'user_ada',
        inviterName: 'Ada',
        inviterAvatarUrl: null,
        targetUserId: 'user_me',
        createdAt: '2026-08-15T12:00:00Z',
        expiresAt: '2026-08-15T12:01:00Z',
        expiresInSeconds: 60,
        participantUserIds: ['user_ada'],
        ...overrides,
    };
}

function ringDto(overrides: Partial<VoiceRingDto> = {}): VoiceRingDto {
    return {
        ringId: 'ring_1',
        guildId: 'g1',
        channelId: 'chan_1',
        channelName: 'General',
        inviterId: 'user_ada',
        targetUserId: 'user_me',
        status: VoiceRingStatus.Accepted,
        reason: null,
        createdAt: '2026-08-15T12:00:00Z',
        expiresAt: '2026-08-15T12:01:00Z',
        expiresInSeconds: 45,
        resolvedByDeviceId: OWN_DEVICE,
        ...overrides,
    };
}

function guildWithVoiceChannel() {
    return {
        id: 'g1',
        name: 'Test Guild',
        channels: [{id: 'chan_1', name: 'General', type: ChannelType.Voice, guildId: 'g1'}],
    };
}

interface SetupOptions {
    ring?: ReturnType<typeof vi.fn>;
    accept?: ReturnType<typeof vi.fn>;
    pending?: ReturnType<typeof vi.fn>;
}

function setup(options: SetupOptions = {}) {
    const ws = {
        voiceRingIncomingObservable: new Subject<WsVoiceRing>(),
        voiceRingSentObservable: new Subject<WsVoiceRing>(),
        voiceRingResolvedObservable: new Subject<WsVoiceRingResolved>(),
        voiceRingDismissedObservable: new Subject<WsVoiceRingDismissed>(),
    };
    const rings = {
        ring: options.ring ?? vi.fn(() => of(ringDto({expiresInSeconds: 60}))),
        pending: options.pending ?? vi.fn(() => of([] as VoiceRingDto[])),
        accept: options.accept ?? vi.fn(() => of(ringDto())),
        decline: vi.fn(() => of(ringDto({status: VoiceRingStatus.Declined}))),
        cancel: vi.fn(() => of(ringDto({status: VoiceRingStatus.Cancelled}))),
    };
    const joinChannel = vi.fn();
    const toast = {info: vi.fn(), error: vi.fn(), success: vi.fn(), warn: vi.fn(), httpError: vi.fn()};
    const connectionState = signal(ConnectionState.Disconnected);

    TestBed.configureTestingModule({
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            {provide: GuildWebsocketService, useValue: ws},
            {provide: VoiceRingService, useValue: rings},
            {provide: RealtimeConnectionService, useValue: {connectionState}},
            {provide: DeviceIdentityService, useValue: {deviceId: () => Promise.resolve(OWN_DEVICE)}},
            {provide: VoiceChannelService, useValue: {joinChannel, joinedChannelId: () => null}},
            {provide: GuildService, useValue: {getGuild: vi.fn(() => of(guildWithVoiceChannel()))}},
            {provide: ProfileService, useValue: {resolveByUserId: vi.fn(), getCachedByUserId: () => null}},
            {provide: ToastService, useValue: toast},
        ],
    });

    return {service: TestBed.inject(VoiceRingStateService), ws, rings, joinChannel, toast, connectionState};
}

describe('VoiceRingStateService incoming', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('stacks a ring that arrives over the hub', () => {
        const {service, ws} = setup();

        ws.voiceRingIncomingObservable.next(ringEvent());

        expect(service.hasIncoming()).toBe(true);
        expect(service.incoming()[0].secondsLeft).toBe(60);
    });

    it('shows two different people at once, newest first', () => {
        const {service, ws} = setup();

        ws.voiceRingIncomingObservable.next(ringEvent());
        ws.voiceRingIncomingObservable.next(ringEvent({
            ringId: 'ring_2', inviterId: 'user_bo', channelId: 'chan_2',
        }));

        expect(service.incoming().map(i => i.ring.ringId)).toEqual(['ring_2', 'ring_1']);
    });

    it('never shows two cards from the same face - the newer supersedes the older', () => {
        const {service, ws} = setup();

        ws.voiceRingIncomingObservable.next(ringEvent());
        ws.voiceRingIncomingObservable.next(ringEvent({ringId: 'ring_2', channelId: 'chan_2'}));

        expect(service.incoming().map(i => i.ring.ringId)).toEqual(['ring_2']);
    });

    it('drops a ring that is already dead on arrival', () => {
        // A push that outlived the invitation: drawing it would draw one nobody can accept.
        const {service, ws} = setup();

        ws.voiceRingIncomingObservable.next(ringEvent({expiresInSeconds: 0}));

        expect(service.hasIncoming()).toBe(false);
    });

    it('reads the pending list on every reconnect, because the event is never replayed', () => {
        const pending = vi.fn(() => of([ringDto({status: VoiceRingStatus.Pending, expiresInSeconds: 30})]));
        const {service, connectionState} = setup({pending});

        connectionState.set(ConnectionState.Connected);
        TestBed.tick();

        expect(pending).toHaveBeenCalled();
        expect(service.incoming()[0].secondsLeft).toBe(30);
    });
});

describe('VoiceRingStateService resolution', () => {
    afterEach(() => TestBed.resetTestingModule());

    it.each([
        [VoiceRingStatus.Accepted, null],
        [VoiceRingStatus.Declined, null],
        [VoiceRingStatus.Cancelled, VoiceRingReason.InviterCancelled],
        [VoiceRingStatus.Cancelled, VoiceRingReason.InviterLeft],
        [VoiceRingStatus.Cancelled, VoiceRingReason.Superseded],
        [VoiceRingStatus.Cancelled, VoiceRingReason.TargetJoined],
        [VoiceRingStatus.Cancelled, VoiceRingReason.ChannelGone],
        [VoiceRingStatus.Expired, VoiceRingReason.TimedOut],
    ] as const)('takes the card down on %s / %s', (status, reason) => {
        const {service, ws} = setup();
        ws.voiceRingIncomingObservable.next(ringEvent());

        ws.voiceRingResolvedObservable.next({
            ringId: 'ring_1', guildId: 'g1', channelId: 'chan_1',
            inviterId: 'user_ada', targetUserId: 'user_me',
            status, reason, resolvedAt: '2026-08-15T12:00:14Z', resolvedByDeviceId: null,
        });

        expect(service.hasIncoming()).toBe(false);
    });

    it('survives a status it has never heard of', () => {
        const {service, ws} = setup();
        ws.voiceRingIncomingObservable.next(ringEvent());

        ws.voiceRingResolvedObservable.next({
            ringId: 'ring_1', guildId: 'g1', channelId: 'chan_1',
            inviterId: 'user_ada', targetUserId: 'user_me',
            status: 'Vaporised', reason: 'SunExploded',
            resolvedAt: '2026-08-15T12:00:14Z', resolvedByDeviceId: null,
        });

        expect(service.hasIncoming()).toBe(false);
    });

    it('says nothing when this very device is the one that answered', async () => {
        const {service, ws, toast} = setup();
        // The device id resolves on a microtask, so let it land before the comparison matters.
        await Promise.resolve();
        await Promise.resolve();

        // Resolved by us: re-announcing would tell somebody they declined a second after they did.
        ws.voiceRingResolvedObservable.next({
            ringId: 'ring_1', guildId: 'g1', channelId: 'chan_1',
            inviterId: 'user_me', targetUserId: 'user_ada',
            status: VoiceRingStatus.Declined, reason: null,
            resolvedAt: '2026-08-15T12:00:14Z', resolvedByDeviceId: OWN_DEVICE,
        });

        expect(toast.info).not.toHaveBeenCalled();
        expect(service.hasIncoming()).toBe(false);
    });

    it('takes the card down on a dismissal addressed to this device alone', () => {
        const {service, ws} = setup();
        ws.voiceRingIncomingObservable.next(ringEvent());

        // The ordinary multi-device outcome: the phone answered a second before the laptop.
        ws.voiceRingDismissedObservable.next({
            ringId: 'ring_1', deviceId: OWN_DEVICE, status: VoiceRingStatus.Accepted, reason: null,
        });

        expect(service.hasIncoming()).toBe(false);
    });
});

describe('VoiceRingStateService accept', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('accepts and then joins - two calls, in that order, and no second join path', () => {
        const {service, ws, rings, joinChannel} = setup();
        ws.voiceRingIncomingObservable.next(ringEvent());

        service.accept('ring_1');

        expect(rings.accept).toHaveBeenCalledWith('ring_1');
        expect(joinChannel).toHaveBeenCalledTimes(1);
        expect(joinChannel.mock.calls[0][0].id).toBe('chan_1');
        expect(service.hasIncoming()).toBe(false);
    });

    it('treats a 409 on accept as the normal multi-device outcome, not an error', () => {
        const accept = vi.fn(() => throwError(() => new HttpErrorResponse({status: 409})));
        const {service, ws, toast, joinChannel} = setup({accept});
        ws.voiceRingIncomingObservable.next(ringEvent());

        service.accept('ring_1');

        expect(toast.error).not.toHaveBeenCalled();
        expect(joinChannel).not.toHaveBeenCalled();
    });

    it('says the channel is gone on a 410, and does not try to join it', () => {
        const accept = vi.fn(() => throwError(() =>
            new HttpErrorResponse({status: 410, error: {reason: 'ChannelGone'}})));
        const {service, ws, toast, joinChannel} = setup({accept});
        ws.voiceRingIncomingObservable.next(ringEvent());

        service.accept('ring_1');

        expect(toast.info).toHaveBeenCalledWith('VOICE_RING.CHANNEL_GONE');
        expect(joinChannel).not.toHaveBeenCalled();
    });

    it('declining takes the card down and tells the server, which is what locks the inviter out', () => {
        const {service, ws, rings} = setup();
        ws.voiceRingIncomingObservable.next(ringEvent());

        service.decline('ring_1');

        expect(rings.decline).toHaveBeenCalledWith('ring_1');
        expect(service.hasIncoming()).toBe(false);
    });

    it('dropping a card is not declining it, and carries none of a decline\'s weight', () => {
        const {service, ws, rings} = setup();
        ws.voiceRingIncomingObservable.next(ringEvent());

        service.dropIncoming('ring_1');

        expect(rings.decline).not.toHaveBeenCalled();
        expect(service.hasIncoming()).toBe(false);
    });
});

describe('VoiceRingStateService sending', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('holds a pending state for the channel it rang into', () => {
        const {service} = setup();

        service.send('g1', 'chan_1', 'user_ada');

        expect(service.outgoingFor('g1', 'chan_1')?.targetUserId).toBe('user_ada');
        expect(service.outgoingFor('g1', 'chan_2')).toBeNull();
    });

    it('mirrors a ring sent from another window without re-sending it', () => {
        const {service, ws, rings} = setup();

        ws.voiceRingSentObservable.next(ringEvent({targetUserId: 'user_bo'}));

        expect(service.outgoingFor('g1', 'chan_1')?.targetUserId).toBe('user_bo');
        expect(rings.ring).not.toHaveBeenCalled();
    });

    it.each([
        [VoiceRingRefusalReason.TargetCannotJoinChannel, 'VOICE_RING.REFUSED_NO_ACCESS'],
        [VoiceRingRefusalReason.Unavailable, 'VOICE_RING.REFUSED_UNAVAILABLE'],
        [VoiceRingRefusalReason.RecentlyDeclined, 'VOICE_RING.REFUSED_RECENTLY_DECLINED'],
        [VoiceRingRefusalReason.InviterFlooding, 'VOICE_RING.REFUSED_TOO_MANY_SENT'],
        [VoiceRingRefusalReason.TargetSaturated, 'VOICE_RING.REFUSED_TARGET_SATURATED'],
    ] as const)('renders %s honestly', (reason, key) => {
        const ring = vi.fn(() => throwError(() =>
            new HttpErrorResponse({status: 429, error: {reason, retryAfterSeconds: 900}})));
        const {service} = setup({ring});

        service.send('g1', 'chan_1', 'user_ada');

        expect(service.refusalFor('g1', 'chan_1')?.messageKey).toBe(key);
    });

    it('never renders a block as "you are blocked"', () => {
        // The server does not say which direction the block runs in, so neither may the copy.
        const key = refusalMessageKey(VoiceRingRefusalReason.Unavailable);

        expect(key).toBe('VOICE_RING.REFUSED_UNAVAILABLE');
        expect(key).not.toContain('BLOCK');
    });

    it('falls back to a generic message for a refusal reason it does not know', () => {
        expect(refusalMessageKey('SomethingNew')).toBe('VOICE_RING.REFUSED_GENERIC');
        expect(refusalMessageKey(undefined)).toBe('VOICE_RING.REFUSED_GENERIC');
    });

    it('shows nothing at all when they walked into the channel first', () => {
        const ring = vi.fn(() => throwError(() => new HttpErrorResponse({
            status: 409, error: {reason: VoiceRingRefusalReason.TargetAlreadyInChannel, retryAfterSeconds: 0},
        })));
        const {service} = setup({ring});

        service.send('g1', 'chan_1', 'user_ada');

        expect(service.refusalFor('g1', 'chan_1')).toBeNull();
    });

    it('hides a 400 entirely - it is a bug in this client, not news for the user', () => {
        const ring = vi.fn(() => throwError(() => new HttpErrorResponse({status: 400})));
        const {service} = setup({ring});

        service.send('g1', 'chan_1', 'user_ada');

        expect(service.refusalFor('g1', 'chan_1')).toBeNull();
    });

    it('explains a bare 403 as "you are not in that channel"', () => {
        const ring = vi.fn(() => throwError(() => new HttpErrorResponse({status: 403})));
        const {service} = setup({ring});

        service.send('g1', 'chan_1', 'user_ada');

        expect(service.refusalFor('g1', 'chan_1')?.messageKey).toBe('VOICE_RING.NOT_IN_CHANNEL');
    });

    it('carries the retry window so the button can hold itself shut', () => {
        const ring = vi.fn(() => throwError(() => new HttpErrorResponse({
            status: 429,
            error: {reason: VoiceRingRefusalReason.InviterFlooding, retryAfterSeconds: 120},
        })));
        const {service} = setup({ring});

        service.send('g1', 'chan_1', 'user_ada');

        expect(service.refusalFor('g1', 'chan_1')?.retryAfterSeconds).toBe(120);
    });

    it('cancelling clears the pending state and tells the server', () => {
        const {service, rings} = setup();
        service.send('g1', 'chan_1', 'user_ada');

        service.cancel('g1', 'chan_1');

        expect(rings.cancel).toHaveBeenCalledWith('ring_1');
        expect(service.outgoingFor('g1', 'chan_1')).toBeNull();
    });
});
