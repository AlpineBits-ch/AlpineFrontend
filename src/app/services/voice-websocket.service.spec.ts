/**
 * These events are the per-device half of the calls contract. The names must match the server
 * exactly - a typo here is a silent no-op, not an error.
 */
import {TestBed} from '@angular/core/testing';
import {firstValueFrom, Subject} from 'rxjs';
import {
    describeCallEndedReason,
    VoiceWebsocketService,
    WsCallDeviceTakeover,
} from './voice-websocket.service';
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
