import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {of, Subject, throwError} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ConversationCallService} from './conversation-call.service';
import {CallStateChangedEvent, OngoingCallDto} from '../dtos/response/ongoing-call.dto';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';
import {CallSessionService} from './call-session.service';
import {MessagingWebsocketService} from './messaging-websocket.service';
import {VoiceService} from './voice.service';

const CONV = 'conv-1';

function ongoing(overrides: Partial<OngoingCallDto> = {}): OngoingCallDto {
    return {
        callId: 'call-1',
        conversationId: CONV,
        status: 'Connected',
        creatorId: 'user-caller',
        startedAt: new Date().toISOString(),
        connectedUserIds: ['user-caller'],
        ...overrides,
    };
}

function changed(overrides: Partial<CallStateChangedEvent> = {}): CallStateChangedEvent {
    return {
        conversationId: CONV,
        callId: 'call-1',
        status: 'Ongoing',
        reason: null,
        participantIds: ['user-caller'],
        ...overrides,
    };
}

interface SetupOptions {
    /** What `GET voice/conversations/{id}/call` answers. Null is "no call", the common case. */
    call?: OngoingCallDto | null;
    fails?: boolean;
    /** The call this client is already on, if any. */
    session?: {callId: string} | null;
}

function setup(options: SetupOptions = {}) {
    const callState = new Subject<CallStateChangedEvent>();
    const voiceService = {
        getConversationCall: vi.fn(() => options.fails
            ? throwError(() => new Error('offline'))
            : of(options.call ?? null)),
    };
    const connectionState = signal(ConnectionState.Connected);

    TestBed.configureTestingModule({
        providers: [
            {provide: MessagingWebsocketService, useValue: {conversationCallStateObservable: callState}},
            {provide: VoiceService, useValue: voiceService},
            {provide: CallSessionService, useValue: {session: () => options.session ?? null}},
            {provide: RealtimeConnectionService, useValue: {connectionState}},
        ],
    });

    const service = TestBed.inject(ConversationCallService);
    return {service, callState, voiceService, connectionState};
}

describe('ConversationCallService', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('reports nothing before anything is known', () => {
        const {service} = setup();

        expect(service.ongoingIn(CONV)).toBeNull();
    });

    it('picks up a call already running when the conversation is opened', () => {
        // The whole reason this read exists: the announcement went out before this conversation
        // was open, and SignalR replays nothing.
        const {service} = setup({call: ongoing()});

        service.refresh(CONV);

        expect(service.ongoingIn(CONV)?.callId).toBe('call-1');
    });

    it('asks the server once per conversation', () => {
        const {service, voiceService} = setup({call: ongoing()});

        service.refresh(CONV);
        service.refresh(CONV);

        expect(voiceService.getConversationCall).toHaveBeenCalledTimes(1);
    });

    it('retries after a failed read', () => {
        // Marked as fetched only on success, so a banner lost to a network blip comes back the
        // next time the conversation is opened.
        const {service, voiceService} = setup({fails: true});

        service.refresh(CONV);
        service.refresh(CONV);

        expect(voiceService.getConversationCall).toHaveBeenCalledTimes(2);
    });

    it('picks up a call that starts while the conversation is open', () => {
        const {service, callState} = setup();

        callState.next(changed());

        expect(service.ongoingIn(CONV)?.callId).toBe('call-1');
    });

    it('drops the call when it ends', () => {
        const {service, callState} = setup({call: ongoing()});
        service.refresh(CONV);

        callState.next(changed({status: 'Ended', reason: 'UserEnded'}));

        expect(service.ongoingIn(CONV)).toBeNull();
    });

    it('keeps conversations independent', () => {
        const {service, callState} = setup();

        callState.next(changed({conversationId: 'conv-2', callId: 'call-2'}));

        expect(service.ongoingIn(CONV)).toBeNull();
        expect(service.ongoingIn('conv-2')?.callId).toBe('call-2');
    });

    it('offers nothing for the call this client is already on', () => {
        // The call panel is the UI at that point - a "join" banner over a call you are in is
        // nonsense, and pressing it would re-accept a call already accepted.
        const {service} = setup({call: ongoing(), session: {callId: 'call-1'}});

        service.refresh(CONV);

        expect(service.ongoingIn(CONV)).toBeNull();
    });

    it('still offers a different call in the same conversation', () => {
        const {service} = setup({call: ongoing({callId: 'call-other'}), session: {callId: 'call-1'}});

        service.refresh(CONV);

        expect(service.ongoingIn(CONV)?.callId).toBe('call-other');
    });

    it('names who is on the call from the live event', () => {
        const {service, callState} = setup();

        callState.next(changed({participantIds: ['a', 'b']}));

        expect(service.ongoingIn(CONV)?.connectedUserIds).toEqual(['a', 'b']);
    });

    it('forgets everything on reconnect so it is re-read rather than trusted', () => {
        // A call can start or end while the socket is down, and neither is re-announced. Stale
        // state here means a join button for a call that is over.
        const {service, callState, connectionState} = setup();
        callState.next(changed());

        connectionState.set(ConnectionState.Disconnected);
        TestBed.flushEffects();
        connectionState.set(ConnectionState.Connected);
        TestBed.flushEffects();

        expect(service.ongoingIn(CONV)).toBeNull();
    });
});
