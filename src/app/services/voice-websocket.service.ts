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
    }
}
