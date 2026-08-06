import {inject, Injectable} from '@angular/core';
import {Subject} from 'rxjs';
import {CallDto} from '../dtos/response/call.dto';
import {ShareViewersDto} from '../dtos/response/share-viewers.dto';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';

// Re-exported for existing importers.
export {ConnectionState};

export interface MessageUpdatedEvent {
    messageId: string;
    content: string;
    authorId: string;
    conversationId: string | undefined;
    channelId: string | undefined;
}

export interface ConversationMemberRemoved {
    conversationId: string;
    userId: string;
    hasLeft: boolean;
}

export interface MessageDeletedEvent {
    messageId: string;
    conversationId: string | undefined;
    channelId: string | undefined;
}

export interface ConversationRemoved {
    conversationId: string;
}

// ── WebRTC call signaling events (server → client) ────────────────────────────

/** Someone joined the call. cfSessionId is their CF Calls session -needed to subscribe to their tracks. */
export interface WsParticipantJoined {
    userId: string;
    cfSessionId: string;
    audioTrackName: string;
}

/** A remote participant published a new video / screen-share track. */
export interface WsTrackPublished {
    userId: string;
    cfSessionId: string;
    trackName: string;
    kind: 'audio' | 'video' | 'screen';
    shareId?: string;
}

export interface WsTrackClosed {
    userId: string;
    trackName: string;
    shareId?: string;
}

export interface WsSpeakingChanged {
    userId: string;
    isSpeaking: boolean;
}

export interface WsMuteChanged {
    userId: string;
    isMuted: boolean;
}

export interface WsCameraChanged {
    userId: string;
    isCameraOn: boolean;
}

export interface WsScreenShareStarted {
    shareId: string;
    userId: string;
    cfSessionId: string;
    trackName: string;
}

export interface WsScreenShareStopped {
    shareId: string;
}

export interface WsCallEnded {
    callId: string;
    reason?: 'Declined' | 'UserEnded' | 'AllParticipantsLeft' | 'AloneTimeout';
}

// ── Per-device call events ────────────────────────────────────────────────────
//
// The server now tells this client which *device* an action came from, so a second device of the
// same user can stop ringing without the call ending for anyone.

/** Some device of ours accepted the call - every other ringing device should stop. */
export interface WsCallAccepted {
    callId: string;
    deviceId: string;
}

/** This device's ring was dismissed because another of ours dealt with the call. */
export interface WsCallDeviceDismissed {
    callId: string;
    deviceId: string;
}

/** We joined the call on another device while still connected here. */
export interface WsCallDeviceTakeover {
    callId: string;
    oldDeviceId: string;
    newDeviceId: string;
}

/** A participant left the call - the only departure event the contract carries. */
export interface WsCallParticipantLeft {
    callId: string;
    userId: string;
}

/** Only one participant is left; the server force-ends the call at `deadline`. */
export interface WsCallAlone {
    callId: string;
    userId: string;
    deadline: string;
}

// ── Call status, as it actually arrives on the wire ───────────────────────────

/**
 * `Messaging.Domain.Enums.CallStatus`, in declaration order.
 *
 * The order is load-bearing: the contract notes the enum is serialised as an int by any host
 * without `JsonStringEnumConverter`, and the gateway is one of them for some payloads, so both
 * shapes reach us for the same field.
 */
const CALL_STATUS_NAMES = ['Pending', 'Ringing', 'Rejected', 'Connected', 'Completed', 'Left'] as const;

export type CallStatusName = typeof CALL_STATUS_NAMES[number];

/** Normalises either wire shape - `"Ringing"` or `1` (or `"1"`) - to the name. */
export function callStatusName(raw: string | number | null | undefined): CallStatusName | undefined {
    if (raw === null || raw === undefined || raw === '') return undefined;
    const ordinal = Number(raw);
    if (Number.isInteger(ordinal)) return CALL_STATUS_NAMES[ordinal];
    return CALL_STATUS_NAMES.find(name => name === raw);
}

/**
 * Does this `call.CallDeclined` end the caller's ring?
 *
 * The payload is the whole `Call`, not "who declined", because one decline does not necessarily
 * end the call: in a group call the other invitees keep ringing and the caller's overlay must stay
 * up. So the question is answered from the roster - is anyone left who could still pick up - with
 * the call's own status as the short circuit for the 1:1 case, where the server has already marked
 * the whole thing Rejected.
 *
 * A server that sends no statuses at all resolves the overlay, which is right for 1:1 (the
 * overwhelmingly common case) and merely early for a group call. Ringing forever is the worse
 * failure, and it is the one that exists today.
 */
export function declineEndsOutgoingCall(call: CallDto, ownUserId?: string): boolean {
    const overall = callStatusName(call.status);
    if (overall === 'Rejected' || overall === 'Completed') return true;

    return !call.participants.some(p => {
        if (p.userId === ownUserId) return false;
        const status = callStatusName(p.status);
        return status === 'Pending' || status === 'Ringing' || status === 'Connected';
    });
}

/**
 * Copy for the toast shown when a call ended for a reason the local user did not cause.
 *
 * Unknown and self-inflicted reasons fall back to the neutral phrasing rather than naming
 * something the user did not do.
 */
export function describeCallEndedReason(reason?: string): string {
    switch (reason) {
        case 'Declined':
            return 'Call declined';
        case 'AloneTimeout':
            return 'Call ended - no one rejoined';
        default:
            return 'Call ended';
    }
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable({providedIn: 'root'})
export class VoiceWebsocketService {
    // ── Inbound observables ──────────────────────────────────────────────────
    public incomingCallObservable = new Subject<CallDto>();
    public participantJoinedObservable = new Subject<WsParticipantJoined>();
    public trackPublishedObservable = new Subject<WsTrackPublished>();
    public trackClosedObservable = new Subject<WsTrackClosed>();
    public speakingChangedObservable = new Subject<WsSpeakingChanged>();
    public muteChangedObservable = new Subject<WsMuteChanged>();
    public cameraChangedObservable = new Subject<WsCameraChanged>();
    public screenShareStartedObservable = new Subject<WsScreenShareStarted>();
    public screenShareStoppedObservable = new Subject<WsScreenShareStopped>();
    public callEndedObservable = new Subject<WsCallEnded>();
    public callAcceptedObservable = new Subject<WsCallAccepted>();
    /** Payload is the whole `Call` entity, not a `{callId}` - see {@link declineEndsOutgoingCall}. */
    public callDeclinedObservable = new Subject<CallDto>();
    /** The audience of one screen share in this call changed. Sent to every participant. */
    public shareViewersChangedObservable = new Subject<ShareViewersDto>();
    public callDeviceDismissedObservable = new Subject<WsCallDeviceDismissed>();
    public callDeviceTakeoverObservable = new Subject<WsCallDeviceTakeover>();
    public callParticipantLeftObservable = new Subject<WsCallParticipantLeft>();
    public callAloneObservable = new Subject<WsCallAlone>();
    private realtime = inject(RealtimeConnectionService);
    private listenersSetUp = false;

    /** Shared connection state -one connection now backs every feature. */
    get connectionState() {
        return this.realtime.connectionState;
    }

    async start(): Promise<void> {
        if (!this.listenersSetUp) {
            this.listenersSetUp = true;
            this.setupListeners();
        }
        await this.realtime.start();
    }

    // ── Outbound hub invocations (client → server) ───────────────────────────

    // Broadcast { userId, isMuted } to all other members of the call.
    invokeMuteChange(callId: string, isMuted: boolean): void {
        void this.realtime.invoke('call.MuteChanged', {callId, isMuted});
    }

    // Broadcast { userId, isCameraOn } to other call members.
    invokeCameraChanged(callId: string, isCameraOn: boolean): void {
        void this.realtime.invoke('call.CameraChanged', {callId, isCameraOn});
    }

    // { shareId, userId, cfSessionId, trackName } to other call members.
    invokeScreenShareStarted(callId: string, shareId: string, trackName: string): void {
        void this.realtime.invoke('call.ScreenShareStarted', {callId, shareId, trackName});
    }

    // Broadcast { shareId } to other call members.
    invokeScreenShareStopped(callId: string, shareId: string): void {
        void this.realtime.invoke('call.ScreenShareStopped', {callId, shareId});
    }

    private setupListeners(): void {
        // ── Call lifecycle ──────────────────────────────────────────────────────
        this.realtime.on('call.IncomingCall', (data: CallDto) => {
            this.incomingCallObservable.next(data);
        });

        // ── WebRTC signaling ────────────────────────────────────────────────────
        this.realtime.on('call.ParticipantJoined', (d: WsParticipantJoined) => this.participantJoinedObservable.next(d));
        this.realtime.on('call.TrackPublished', (d: WsTrackPublished) => this.trackPublishedObservable.next(d));
        this.realtime.on('call.TrackClosed', (d: WsTrackClosed) => this.trackClosedObservable.next(d));
        this.realtime.on('call.SpeakingChanged', (d: WsSpeakingChanged) => this.speakingChangedObservable.next(d));
        this.realtime.on('call.MuteChanged', (d: WsMuteChanged) => this.muteChangedObservable.next(d));
        this.realtime.on('call.CameraChanged', (d: WsCameraChanged) => this.cameraChangedObservable.next(d));
        this.realtime.on('call.ScreenShareStarted', (d: WsScreenShareStarted) => this.screenShareStartedObservable.next(d));
        this.realtime.on('call.ScreenShareStopped', (d: WsScreenShareStopped) => this.screenShareStoppedObservable.next(d));
        this.realtime.on('call.CallEnded', (d: WsCallEnded) => this.callEndedObservable.next(d));

        // ── Per-device call events ──────────────────────────────────────────────
        this.realtime.on('call.CallAccepted', (d: WsCallAccepted) => this.callAcceptedObservable.next(d));
        this.realtime.on('call.CallDeclined', (d: CallDto) => this.callDeclinedObservable.next(d));
        this.realtime.on('call.ShareViewersChanged', (d: ShareViewersDto) => this.shareViewersChangedObservable.next(d));
        this.realtime.on('call.CallDeviceDismissed', (d: WsCallDeviceDismissed) => this.callDeviceDismissedObservable.next(d));
        this.realtime.on('call.CallDeviceTakeover', (d: WsCallDeviceTakeover) => this.callDeviceTakeoverObservable.next(d));
        this.realtime.on('call.CallParticipantLeft', (d: WsCallParticipantLeft) => this.callParticipantLeftObservable.next(d));
        this.realtime.on('call.CallAlone', (d: WsCallAlone) => this.callAloneObservable.next(d));
    }
}
