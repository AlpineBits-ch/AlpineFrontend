/**
 * Bug this fixes: with both devices ringing, declining on one ended the whole call on the other.
 * The ring must now be dismissed by the per-device events rather than by CallEnded alone.
 */
import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {of, Subject, throwError} from 'rxjs';
import {CallDto} from '../dtos/response/call.dto';
import {CallStateService} from './call-state.service';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';
import {CallSessionService} from './call-session.service';
import {VoiceWebsocketService} from './voice-websocket.service';
import {VoiceService} from './voice.service';
import {ProfileService} from './profile.service';
import {ConversationStore} from '../stores/conversation.store';
import {NavigationService} from '../features/main-page/navigation.service';
import {SoundSettingsService} from './sound-settings.service';
import {ToastService} from './toast.service';

interface SetupOptions {
    /** Where the socket already is when the service is constructed. Connected is the cold-start
     *  shape - this service is created lazily, usually well after the connection is up. */
    connectionState?: ConnectionState;
    /** What `GET voice/call/pending` answers. Null is the overwhelmingly common case. */
    pendingCall?: CallDto | null;
    /** Make that request fail instead. */
    pendingCallFails?: boolean;
    /** Raise the incoming-call card before returning, as most of these tests need. */
    ringing?: boolean;
    /** Pretend this client is already in a call. */
    session?: {callId: string} | null;
}

function setup(options: SetupOptions = {}) {
    const ws = {
        incomingCallObservable: new Subject<unknown>(),
        callEndedObservable: new Subject<unknown>(),
        callAcceptedObservable: new Subject<unknown>(),
        callDeviceDismissedObservable: new Subject<unknown>(),
        callDeviceTakeoverObservable: new Subject<unknown>(),
        participantJoinedObservable: new Subject<unknown>(),
    };
    const callSession = {
        session: vi.fn(() => (options.session ?? null) as unknown),
        end: vi.fn(),
        join: vi.fn(),
    };
    const toast = {info: vi.fn(), httpError: vi.fn(), success: vi.fn()};
    const voiceService = {
        getPendingCall: vi.fn(() => options.pendingCallFails
            ? throwError(() => new Error('offline'))
            : of(options.pendingCall ?? null)),
        declineCall: vi.fn(() => of({})),
        acceptCall: vi.fn(() => of({})),
    };
    const connectionState = signal(options.connectionState ?? ConnectionState.Disconnected);

    TestBed.configureTestingModule({
        providers: [
            {provide: VoiceWebsocketService, useValue: ws},
            {provide: CallSessionService, useValue: callSession},
            {provide: VoiceService, useValue: voiceService},
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'me'})}},
            {provide: ConversationStore, useValue: {entities: () => []}},
            {provide: NavigationService, useValue: {openConversation: vi.fn()}},
            {
                provide: SoundSettingsService,
                useValue: {playIncomingRing: vi.fn(), playRingback: vi.fn()},
            },
            {provide: ToastService, useValue: toast},
            {provide: RealtimeConnectionService, useValue: {connectionState}},
        ],
    });

    const service = TestBed.inject(CallStateService);
    if (options.ringing ?? true) {
        service.incomingCall.set({
            call: {id: 'call-1'} as never,
            displayName: 'Alice',
            avatarLabel: 'A',
        });
    }
    // Effects created in the constructor are scheduled, not run inline - and this has to happen
    // after the card above is raised, so the "already ringing" guard sees it.
    TestBed.tick();
    return {service, ws, callSession, toast, voiceService, connectionState};
}

it('stops ringing when another of my devices accepts', () => {
    const {service, ws} = setup();

    ws.callAcceptedObservable.next({callId: 'call-1', deviceId: 'other'});

    expect(service.incomingCall()).toBeNull();
});

it('stops ringing when the server dismisses this device', () => {
    const {service, ws} = setup();

    ws.callDeviceDismissedObservable.next({callId: 'call-1', deviceId: 'mine'});

    expect(service.incomingCall()).toBeNull();
});

it('ignores events for a different call', () => {
    const {service, ws} = setup();

    ws.callAcceptedObservable.next({callId: 'some-other-call', deviceId: 'other'});

    expect(service.incomingCall()).not.toBeNull();
});

it('still dismisses the ring on CallEnded', () => {
    const {service, ws} = setup();

    ws.callEndedObservable.next({callId: 'call-1'});

    expect(service.incomingCall()).toBeNull();
});

it('tears down the active session on takeover without calling leave', () => {
    const {ws, callSession, toast} = setup();
    callSession.session.mockReturnValue({callId: 'call-1'});

    ws.callDeviceTakeoverObservable.next({callId: 'call-1', oldDeviceId: 'a', newDeviceId: 'b'});

    expect(callSession.end).toHaveBeenCalledWith(true);
    expect(toast.info).toHaveBeenCalledWith('You joined this call on another device');
});

it('ignores a takeover for a call we are not in', () => {
    const {ws, callSession} = setup();
    callSession.session.mockReturnValue({callId: 'another-call'});

    ws.callDeviceTakeoverObservable.next({callId: 'call-1', oldDeviceId: 'a', newDeviceId: 'b'});

    expect(callSession.end).not.toHaveBeenCalled();
});

// ── Catch-up on a ring this client was never told about ──────────────────────
//
// `call.IncomingCall` is broadcast once and never replayed. Open the app while somebody is
// already calling - the socket connects seconds after the event went out - and nothing ever
// raised the card. Same gap after a reconnect. `GET voice/call/pending` closes it.

const RINGING_CALL = {
    id: 'call-9',
    conversationId: 'conv-1',
    creatorId: 'user-caller',
    status: 'Pending',
    createdAt: new Date(),
    updatedAt: new Date(),
    tracks: [],
    participants: [{userId: 'me'}, {userId: 'user-caller'}],
} satisfies CallDto;

it('raises the card for a ring that started before this client connected', () => {
    // The effect runs on creation with the connection already up, which is the cold-start shape:
    // this service is constructed lazily, usually well after the socket.
    const {service, voiceService} = setup({
        connectionState: ConnectionState.Connected,
        pendingCall: RINGING_CALL,
        ringing: false,
    });

    expect(voiceService.getPendingCall).toHaveBeenCalled();
    expect(service.incomingCall()?.call.id).toBe('call-9');
});

it('catches up again after a reconnect', () => {
    const {service, voiceService, connectionState} = setup({
        pendingCall: RINGING_CALL,
        ringing: false,
    });

    expect(voiceService.getPendingCall).not.toHaveBeenCalled();
    connectionState.set(ConnectionState.Connected);
    TestBed.tick();

    expect(service.incomingCall()?.call.id).toBe('call-9');
});

it('stays quiet when nothing is ringing', () => {
    const {service, voiceService} = setup({
        connectionState: ConnectionState.Connected,
        pendingCall: null,
        ringing: false,
    });

    expect(voiceService.getPendingCall).toHaveBeenCalled();
    expect(service.incomingCall()).toBeNull();
});

it('does not interrupt a call already in progress', () => {
    const {service, voiceService} = setup({
        connectionState: ConnectionState.Connected,
        pendingCall: RINGING_CALL,
        session: {callId: 'call-1'},
        ringing: false,
    });

    expect(voiceService.getPendingCall).not.toHaveBeenCalled();
    expect(service.incomingCall()).toBeNull();
});

it('does not disturb a ring already on screen', () => {
    const {service, voiceService} = setup({
        connectionState: ConnectionState.Connected,
        pendingCall: RINGING_CALL,
    });

    expect(voiceService.getPendingCall).not.toHaveBeenCalled();
    expect(service.incomingCall()?.call.id).toBe('call-1');
});

it('swallows a failed catch-up rather than surfacing it', () => {
    // Nobody asked for this request; a network blip during it must not produce an error toast, and
    // must leave the in-flight guard clear so the next connect tries again.
    const {service, connectionState, voiceService} = setup({
        connectionState: ConnectionState.Connected,
        pendingCallFails: true,
        ringing: false,
    });

    expect(service.incomingCall()).toBeNull();

    connectionState.set(ConnectionState.Disconnected);
    TestBed.tick();
    connectionState.set(ConnectionState.Connected);
    TestBed.tick();

    expect(voiceService.getPendingCall).toHaveBeenCalledTimes(2);
});

it('names the ring from creatorId rather than guessing at the roster', () => {
    // Filtering "participants that are not me" picks an arbitrary invitee in a group call, and with
    // no own profile loaded it matches everyone - including the recipient.
    const {service} = setup({
        connectionState: ConnectionState.Connected,
        pendingCall: {
            ...RINGING_CALL,
            participants: [{userId: 'me'}, {userId: 'user-bystander'}, {userId: 'user-caller'}],
        },
        ringing: false,
    });

    expect(service.incomingCall()?.call.creatorId).toBe('user-caller');
});
