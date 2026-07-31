import {inject, Injectable} from '@angular/core';
import {Subject} from 'rxjs';
import {CallDto} from '../dtos/response/call.dto';
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

export interface WsParticipantLeft {
    userId: string;
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

/** Application-level departure, distinct from the WebRTC-level `call.ParticipantLeft`. */
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
    public participantLeftObservable = new Subject<WsParticipantLeft>();
    public trackPublishedObservable = new Subject<WsTrackPublished>();
    public trackClosedObservable = new Subject<WsTrackClosed>();
    public speakingChangedObservable = new Subject<WsSpeakingChanged>();
    public muteChangedObservable = new Subject<WsMuteChanged>();
    public cameraChangedObservable = new Subject<WsCameraChanged>();
    public screenShareStartedObservable = new Subject<WsScreenShareStarted>();
    public screenShareStoppedObservable = new Subject<WsScreenShareStopped>();
    public callEndedObservable = new Subject<WsCallEnded>();
    public callAcceptedObservable = new Subject<WsCallAccepted>();
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
        this.realtime.on('call.ParticipantLeft', (d: WsParticipantLeft) => this.participantLeftObservable.next(d));
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
        this.realtime.on('call.CallDeviceDismissed', (d: WsCallDeviceDismissed) => this.callDeviceDismissedObservable.next(d));
        this.realtime.on('call.CallDeviceTakeover', (d: WsCallDeviceTakeover) => this.callDeviceTakeoverObservable.next(d));
        this.realtime.on('call.CallParticipantLeft', (d: WsCallParticipantLeft) => this.callParticipantLeftObservable.next(d));
        this.realtime.on('call.CallAlone', (d: WsCallAlone) => this.callAloneObservable.next(d));
    }
}
