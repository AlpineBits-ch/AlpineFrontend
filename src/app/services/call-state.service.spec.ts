/**
 * Bug this fixes: with both devices ringing, declining on one ended the whole call on the other.
 * The ring must now be dismissed by the per-device events rather than by CallEnded alone.
 */
import {TestBed} from '@angular/core/testing';
import {Subject} from 'rxjs';
import {CallStateService} from './call-state.service';
import {CallSessionService} from './call-session.service';
import {VoiceWebsocketService} from './voice-websocket.service';
import {VoiceService} from './voice.service';
import {ProfileService} from './profile.service';
import {ConversationStore} from '../stores/conversation.store';
import {NavigationService} from '../features/main-page/navigation.service';
import {SoundSettingsService} from './sound-settings.service';
import {ToastService} from './toast.service';

function setup() {
    const ws = {
        incomingCallObservable: new Subject<unknown>(),
        callEndedObservable: new Subject<unknown>(),
        callAcceptedObservable: new Subject<unknown>(),
        callDeviceDismissedObservable: new Subject<unknown>(),
        callDeviceTakeoverObservable: new Subject<unknown>(),
        participantJoinedObservable: new Subject<unknown>(),
    };
    const callSession = {session: vi.fn(() => null as unknown), end: vi.fn(), join: vi.fn()};
    const toast = {info: vi.fn(), httpError: vi.fn(), success: vi.fn()};

    TestBed.configureTestingModule({
        providers: [
            {provide: VoiceWebsocketService, useValue: ws},
            {provide: CallSessionService, useValue: callSession},
            {provide: VoiceService, useValue: {}},
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'me'})}},
            {provide: ConversationStore, useValue: {entities: () => []}},
            {provide: NavigationService, useValue: {openConversation: vi.fn()}},
            {
                provide: SoundSettingsService,
                useValue: {playIncomingRing: vi.fn(), playRingback: vi.fn()},
            },
            {provide: ToastService, useValue: toast},
        ],
    });

    const service = TestBed.inject(CallStateService);
    service.incomingCall.set({
        call: {id: 'call-1'} as never,
        displayName: 'Alice',
        avatarLabel: 'A',
    });
    return {service, ws, callSession, toast};
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
