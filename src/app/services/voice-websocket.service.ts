import {inject, Injectable, signal} from '@angular/core';
import * as signalR from '@microsoft/signalr';
import {NotificationService, NotificationSound} from './notification.service';
import {environment} from '../../environments/environment';
import {Subject} from 'rxjs';
import {CallDto} from '../dtos/response/call.dto';
import {AuthService} from './auth.service';

export enum ConnectionState {
    Connected,
    Disconnected,
    Connecting,
}

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

/** Someone joined the call. cfSessionId is their CF Calls session — needed to subscribe to their tracks. */
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
    public connectionState = signal(ConnectionState.Disconnected);
    private hubConnection: signalR.HubConnection;
    private authService = inject(AuthService);
    private notificationService = inject(NotificationService);
    private listenersSetUp = false;
    private reconnectNotified = false;

    constructor() {
        this.hubConnection = new signalR.HubConnectionBuilder()
            .withUrl(environment.apiUrl + '/api/v1/messaging/ws/hubs/voice', {
                accessTokenFactory: () => this.authService.ensureValidToken(),
            })
            .withAutomaticReconnect({
                nextRetryDelayInMilliseconds: retryContext =>
                    Math.min(1000 * Math.pow(2, retryContext.previousRetryCount), 60_000),
            })
            .build();
    }

    async start(): Promise<void> {
        if (this.hubConnection.state === signalR.HubConnectionState.Connected) return;
        try {
            await this.hubConnection.start();
            this.connectionState.set(ConnectionState.Connected);
            if (!this.listenersSetUp) {
                this.listenersSetUp = true;
                await this.setupListeners();
            }
        } catch (err) {
            console.error('VoiceWS: connection error', err);
        }
    }

    // Broadcast { userId, isMuted } to all other members of the call.
    invokeMuteChange(callId: string, isMuted: boolean): void {
        void this.hubConnection.invoke('MuteChanged', {callId, isMuted});
    }

    // ── Outbound hub invocations (client → server) ───────────────────────────

    // TODO(backend): Handle hub method 'MuteChanged'.

    // Broadcast { userId, isCameraOn } to other call members.
    invokeCameraChanged(callId: string, isCameraOn: boolean): void {
        void this.hubConnection.invoke('CameraChanged', {callId, isCameraOn});
    }

    // TODO(backend): Handle hub method 'CameraChanged'.

    // { shareId, userId, cfSessionId, trackName } to other call members.
    invokeScreenShareStarted(callId: string, shareId: string, trackName: string): void {
        void this.hubConnection.invoke('ScreenShareStarted', {callId, shareId, trackName});
    }

    // TODO(backend): Handle hub method 'ScreenShareStarted'.
    // Look up the caller's cfSessionId from the database and broadcast

    // Broadcast { shareId } to other call members.
    invokeScreenShareStopped(callId: string, shareId: string): void {
        void this.hubConnection.invoke('ScreenShareStopped', {callId, shareId});
    }

    // TODO(backend): Handle hub method 'ScreenShareStopped'.

    private async setupListeners(): Promise<void> {
        // ── Call lifecycle ──────────────────────────────────────────────────────
        this.hubConnection.on('IncomingCall', (data: CallDto) => {
            this.incomingCallObservable.next(data);
        });

        // ── WebRTC signaling ────────────────────────────────────────────────────
        // TODO(backend): Emit 'ParticipantJoined' to all existing call members when
        // someone joins. Payload: { userId, cfSessionId, audioTrackName }.
        // The cfSessionId + audioTrackName allow others to subscribe via CF Calls.
        this.hubConnection.on('ParticipantJoined', (d: WsParticipantJoined) => this.participantJoinedObservable.next(d));

        // TODO(backend): Emit 'ParticipantLeft' to remaining members when someone leaves.
        // Payload: { userId }.
        this.hubConnection.on('ParticipantLeft', (d: WsParticipantLeft) => this.participantLeftObservable.next(d));

        // TODO(backend): Emit 'TrackPublished' when a user publishes a new video or
        // screen-share track. Payload: { userId, cfSessionId, trackName, kind, shareId? }.
        this.hubConnection.on('TrackPublished', (d: WsTrackPublished) => this.trackPublishedObservable.next(d));

        // TODO(backend): Emit 'TrackClosed' when a user removes a track.
        // Payload: { userId, trackName, shareId? }.
        this.hubConnection.on('TrackClosed', (d: WsTrackClosed) => this.trackClosedObservable.next(d));

        // TODO(backend): Optionally emit 'SpeakingChanged' from server-side VAD.
        // The client runs its own AudioContext VAD, so this is only needed if you want
        // remote speaking state without client-side detection. Payload: { userId, isSpeaking }.
        this.hubConnection.on('SpeakingChanged', (d: WsSpeakingChanged) => this.speakingChangedObservable.next(d));

        // TODO(backend): Relay 'MuteChanged' hub invocations to other call members.
        // Payload delivered to subscribers: { userId, isMuted }.
        this.hubConnection.on('MuteChanged', (d: WsMuteChanged) => this.muteChangedObservable.next(d));

        // TODO(backend): Relay 'CameraChanged' to other call members.
        // Payload: { userId, isCameraOn }.
        this.hubConnection.on('CameraChanged', (d: WsCameraChanged) => this.cameraChangedObservable.next(d));

        // TODO(backend): Relay 'ScreenShareStarted' to other call members.
        // Payload: { shareId, userId, cfSessionId, trackName }.
        this.hubConnection.on('ScreenShareStarted', (d: WsScreenShareStarted) => this.screenShareStartedObservable.next(d));

        // TODO(backend): Relay 'ScreenShareStopped' to other call members.
        // Payload: { shareId }.
        this.hubConnection.on('ScreenShareStopped', (d: WsScreenShareStopped) => this.screenShareStoppedObservable.next(d));

        // TODO(backend): Emit 'CallEnded' to all remaining members when the host ends
        // the call server-side. Payload: { callId }.
        this.hubConnection.on('CallEnded', (d: WsCallEnded) => this.callEndedObservable.next(d));

        // ── Connection state ────────────────────────────────────────────────────
        this.hubConnection.onreconnecting(() => {
            if (!this.reconnectNotified) {
                this.reconnectNotified = true;
                this.notificationService.createNotification({
                    title: 'Connection lost to voice server',
                    message: 'Attempting to reconnect...',
                    sound: NotificationSound.NewMessage,
                }).catch(() => {
                });
            }
            this.connectionState.set(ConnectionState.Connecting);
        });

        this.hubConnection.onreconnected(() => {
            this.reconnectNotified = false;
            this.connectionState.set(ConnectionState.Connected);
        });

        this.hubConnection.onclose(() => {
            this.reconnectNotified = false;
            this.connectionState.set(ConnectionState.Disconnected);
        });
    }
}
