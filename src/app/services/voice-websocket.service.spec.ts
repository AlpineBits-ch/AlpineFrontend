/** The per-device half of the calls contract. Event names must match the server exactly: a typo is a silent no-op, not an error. */
import {TestBed} from '@angular/core/testing';
import {firstValueFrom, Subject} from 'rxjs';
import {
    callStatusName,
    declineEndsOutgoingCall,
    describeCallEndedReason,
    VoiceWebsocketService,
    WsCallDeviceTakeover,
} from './voice-websocket.service';
import {CallDto} from '../dtos/response/call.dto';
import {RealtimeConnectionService} from './realtime-connection.service';

function setup() {
    const handlers = new Map<string, (payload: unknown) => void>();
    const realtime = {
        on: vi.fn((event: string, handler: (payload: unknown) => void) => handlers.set(event, handler)),
        off: vi.fn(),
        invoke: vi.fn(),
        start: vi.fn(async () => undefined),
        connectionState: () => 0,
    };

    TestBed.configureTestingModule({
        providers: [{provide: RealtimeConnectionService, useValue: realtime}],
    });

    return {service: TestBed.inject(VoiceWebsocketService), handlers};
}

it.each([
    ['call.CallAccepted', 'callAcceptedObservable'],
    ['call.CallDeviceDismissed', 'callDeviceDismissedObservable'],
    ['call.CallDeviceTakeover', 'callDeviceTakeoverObservable'],
    ['call.CallParticipantLeft', 'callParticipantLeftObservable'],
    ['call.CallAlone', 'callAloneObservable'],
] as const)('relays %s', async (event, observable) => {
    const {service, handlers} = setup();
    await service.start();

    const received = firstValueFrom(service[observable] as Subject<unknown>);
    handlers.get(event)!({callId: 'call-1'});

    await expect(received).resolves.toEqual({callId: 'call-1'});
});

it('relays call.CallDeclined with the whole Call entity', async () => {
    // Not a `{callId}` like its neighbours: the contract types this one as
    // `Messaging.Domain.Entities.Call`, and the roster in it is what tells a group decline from a
    // final one. Keying off `callId` here would read undefined and match nothing.
    const {service, handlers} = setup();
    await service.start();

    const received = firstValueFrom(service.callDeclinedObservable);
    handlers.get('call.CallDeclined')!({id: 'call-1', status: 'Rejected', participants: []});

    await expect(received).resolves.toEqual({id: 'call-1', status: 'Rejected', participants: []});
});

it('subscribes to no event outside the contract', async () => {
    // `call.ParticipantLeft` was listened for alongside `call.CallParticipantLeft` on the theory
    // that one was WebRTC-level and the other application-level. The contract only has the latter.
    const {service, handlers} = setup();
    await service.start();

    expect(handlers.has('call.ParticipantLeft')).toBe(false);
    expect(handlers.has('call.CallParticipantLeft')).toBe(true);
});

it('carries both device ids on a takeover', async () => {
    const {service, handlers} = setup();
    await service.start();

    const received = firstValueFrom(service.callDeviceTakeoverObservable);
    const payload: WsCallDeviceTakeover = {callId: 'c1', oldDeviceId: 'a', newDeviceId: 'b'};
    handlers.get('call.CallDeviceTakeover')!(payload);

    await expect(received).resolves.toEqual(payload);
});

it('carries the reason on CallEnded', async () => {
    const {service, handlers} = setup();
    await service.start();

    const received = firstValueFrom(service.callEndedObservable);
    handlers.get('call.CallEnded')!({callId: 'c1', reason: 'AloneTimeout'});

    await expect(received).resolves.toEqual({callId: 'c1', reason: 'AloneTimeout'});
});

it.each([
    ['Declined', 'Call declined'],
    ['AloneTimeout', 'Call ended - no one rejoined'],
    ['UserEnded', 'Call ended'],
    ['AllParticipantsLeft', 'Call ended'],
    [undefined, 'Call ended'],
])('describes the %s end reason', (reason, expected) => {
    expect(describeCallEndedReason(reason)).toBe(expected);
});

// ── CallStatus normalization ─────────────────────────────────────────────────
//
// The contract says outright that this enum is an int when serialised by a host without
// JsonStringEnumConverter. Both shapes therefore reach us for the same field, and a raw
// `status === 'Rejected'` silently never matches on the int path.

it.each([
    ['Ringing', 'Ringing'],
    [1, 'Ringing'],
    ['1', 'Ringing'],
    [0, 'Pending'],
    [2, 'Rejected'],
    [5, 'Left'],
    [undefined, undefined],
    [null, undefined],
    ['', undefined],
    [99, undefined],
    ['Nonsense', undefined],
])('normalises the %s call status', (raw, expected) => {
    expect(callStatusName(raw as string | number | null | undefined)).toBe(expected);
});

// ── Which declines end the caller's ring ─────────────────────────────────────

function call(overrides: Partial<CallDto>): CallDto {
    return {
        id: 'c1',
        conversationId: 'conv',
        createdAt: new Date(),
        updatedAt: new Date(),
        tracks: [],
        participants: [],
        ...overrides,
    };
}

it('ends the ring when the call itself is Rejected', () => {
    expect(declineEndsOutgoingCall(call({status: 'Rejected'}), 'me')).toBe(true);
    expect(declineEndsOutgoingCall(call({status: 2}), 'me')).toBe(true);
});

it('ends the ring when nobody else can still pick up', () => {
    const declined = call({
        status: 'Ringing',
        participants: [
            {userId: 'me', status: 'Connected'},
            {userId: 'callee', status: 'Rejected'},
        ],
    });

    expect(declineEndsOutgoingCall(declined, 'me')).toBe(true);
});

it('keeps the ring while another invitee is still ringing', () => {
    const declined = call({
        status: 'Ringing',
        participants: [
            {userId: 'me', status: 'Connected'},
            {userId: 'callee', status: 'Rejected'},
            {userId: 'other', status: 1},
        ],
    });

    expect(declineEndsOutgoingCall(declined, 'me')).toBe(false);
});

it('does not count the caller as someone who could still answer', () => {
    // Own status is Connected from the moment the call is placed; reading it as "somebody is
    // still there" would make the overlay outlast every decline.
    const declined = call({
        status: 'Ringing',
        participants: [{userId: 'me', status: 'Connected'}],
    });

    expect(declineEndsOutgoingCall(declined, 'me')).toBe(true);
});

it('ends the ring when the server sends no statuses at all', () => {
    // Right for 1:1, merely early for a group call - and ringing forever is the worse failure.
    const declined = call({participants: [{userId: 'me'}, {userId: 'callee'}]});

    expect(declineEndsOutgoingCall(declined, 'me')).toBe(true);
});
