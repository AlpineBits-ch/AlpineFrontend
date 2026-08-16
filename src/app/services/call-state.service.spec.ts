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
    /** What `POST voice/call` answers when {@link CallStateService.startCall} places one. */
    createdCall?: CallDto;
}

/** The call this client places in the outgoing-decline tests below. */
const OUTGOING_CALL: CallDto = {
    id: 'call-out',
    conversationId: 'conv-1',
    creatorId: 'me',
    status: 'Ringing',
    createdAt: new Date(),
    updatedAt: new Date(),
    tracks: [],
    participants: [{userId: 'me'}, {userId: 'callee'}],
};

function setup(options: SetupOptions = {}) {
    const ws = {
        incomingCallObservable: new Subject<unknown>(),
        callEndedObservable: new Subject<unknown>(),
        callAcceptedObservable: new Subject<unknown>(),
        callDeclinedObservable: new Subject<CallDto>(),
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
        createCall: vi.fn(() => of(options.createdCall ?? OUTGOING_CALL)),
        leaveCall: vi.fn(() => of({})),
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

// The payload here is the real one. It used to be `{callId, deviceId}` - a shape the server has
// never sent - which is why these passed while the ring carried on in production: the server sends
// `{callId, userId, deviceId, call}`, and before that it sent the bare `Call`, whose id field is
// `id`, so `callId` read as undefined and matched no call at all.
it('stops ringing when another of my devices accepts', () => {
    const {service, ws} = setup();

    ws.callAcceptedObservable.next({
        callId: 'call-1',
        userId: 'me',
        deviceId: 'other',
        call: {id: 'call-1', conversationId: 'conv-1'},
    });

    expect(service.incomingCall()).toBeNull();
});

it('stops ringing when the server dismisses this device', () => {
    const {service, ws} = setup();

    ws.callDeviceDismissedObservable.next({callId: 'call-1', deviceId: 'mine'});

    expect(service.incomingCall()).toBeNull();
});

it('ignores events for a different call', () => {
    const {service, ws} = setup();

    ws.callAcceptedObservable.next({
        callId: 'some-other-call',
        userId: 'me',
        deviceId: 'other',
        call: {id: 'some-other-call', conversationId: 'conv-1'},
    });

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

// ── The callee saying no ─────────────────────────────────────────────────────
//
// `call.CallDeclined` had no listener at all, so a declined outgoing call sat there ringing until
// the server's alone-timeout eventually killed it minutes later.

it('stops the outgoing ring when the callee declines', () => {
    const {service, ws, callSession, toast} = setup({ringing: false});
    service.startCall('conv-1', ['callee'], 'Alice', 'A');
    expect(service.outgoingCall()).not.toBeNull();

    ws.callDeclinedObservable.next({
        ...OUTGOING_CALL,
        status: 'Rejected',
        participants: [{userId: 'me'}, {userId: 'callee', status: 'Rejected'}],
    });

    expect(service.outgoingCall()).toBeNull();
    // Silent: the server has already marked the call Rejected, so `leave` would be a request
    // against a participant record that is gone.
    expect(callSession.end).toHaveBeenCalledWith(true);
    expect(toast.info).toHaveBeenCalledWith('Call declined');
});

it('keeps ringing when one of several invitees declines', () => {
    const {service, ws, callSession} = setup({
        ringing: false,
        createdCall: {
            ...OUTGOING_CALL,
            participants: [{userId: 'me'}, {userId: 'callee'}, {userId: 'other'}],
        },
    });
    service.startCall('conv-1', ['callee', 'other'], 'Alice', 'A');

    ws.callDeclinedObservable.next({
        ...OUTGOING_CALL,
        status: 'Ringing',
        participants: [
            {userId: 'me', status: 'Connected'},
            {userId: 'callee', status: 'Rejected'},
            {userId: 'other', status: 'Ringing'},
        ],
    });

    expect(service.outgoingCall()).not.toBeNull();
    expect(callSession.end).not.toHaveBeenCalled();

    service.cancelOutgoing(); // stop the ringback timer re-arming past the test
});

it('ignores a decline for someone else\'s call', () => {
    const {service, ws} = setup({ringing: false});
    service.startCall('conv-1', ['callee'], 'Alice', 'A');

    ws.callDeclinedObservable.next({...OUTGOING_CALL, id: 'a-different-call', status: 'Rejected'});

    expect(service.outgoingCall()).not.toBeNull();

    service.cancelOutgoing();
});

// ── The callee saying yes ────────────────────────────────────────────────────
//
// The outgoing ring used to end only on `call.ParticipantJoined`, which is a media-plane event: it
// fires when the answering client publishes a microphone, is addressed only to people already in
// the voice room, and is never repeated. The caller is not in that room until their own Rust
// publisher opens a primary session seconds after the call is placed, so a callee who answers
// quickly - a phone off a VoIP push - publishes into a room the caller is not in yet, and the
// caller is never told. Audio still recovers, because the snapshot backfill repairs it; the
// ringback cannot, because that backfill writes into CallSessionService and never reaches the
// observable this race listens to. `call.CallAccepted` is the answer itself and needs none of that.

/** `call.CallAccepted` as the server actually sends it - see CallAcceptedHandler. */
const ACCEPTED = {
    callId: 'call-out',
    userId: 'callee',
    deviceId: 'phone-1',
    call: {...OUTGOING_CALL, status: 'Connected'},
};

it('stops the outgoing ring when the callee answers, without waiting for their audio', () => {
    const {service, ws} = setup({ringing: false});
    service.startCall('conv-1', ['callee'], 'Alice', 'A');
    expect(service.outgoingCall()).not.toBeNull();

    ws.callAcceptedObservable.next(ACCEPTED);

    expect(service.outgoingCall()).toBeNull();
});

it('leaves the call running when the callee answers', () => {
    // Answering is the opposite of declining: nothing is torn down and nothing is announced.
    const {service, ws, callSession, toast} = setup({ringing: false});
    service.startCall('conv-1', ['callee'], 'Alice', 'A');

    ws.callAcceptedObservable.next(ACCEPTED);

    expect(callSession.end).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    expect(service.outgoingCall()).toBeNull();
});

it('ignores an accept for someone else\'s call', () => {
    const {service, ws} = setup({ringing: false});
    service.startCall('conv-1', ['callee'], 'Alice', 'A');

    ws.callAcceptedObservable.next({...ACCEPTED, callId: 'a-different-call'});

    expect(service.outgoingCall()).not.toBeNull();

    service.cancelOutgoing();
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
