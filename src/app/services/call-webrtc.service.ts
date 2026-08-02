import {computed, effect, inject, Injectable, signal, untracked} from '@angular/core';
import {firstValueFrom, Subscription} from 'rxjs';
import {OAuthService} from 'angular-oauth2-oidc';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';
import {VoiceEngineService, VoiceSession} from './voice-engine.service';
import {CallSessionService} from './call-session.service';
import {CfTrackNew, CfTrackResult, VoiceService} from './voice.service';
import {ConnectionState, describeCallEndedReason, VoiceWebsocketService} from './voice-websocket.service';
import {ToastService} from './toast.service';
import {AudioSettingsService} from './audio-settings.service';
import {RustMediaService} from './rust-media.service';
import {ScreenPickerService} from './screen-picker.service';
import type {CallDto} from '../dtos/response/call.dto';
import {DEFAULT_STREAM_PRESET, StreamPreset} from '../models/stream-preset';
import {
    applyScreenEncoding,
    applySimpleBitrate,
    CAMERA_KBPS,
    preferVideoCodecs,
} from './webrtc-encoding';

export interface CallStats {
    inboundKbps: number;
    outboundKbps: number;
    inboundAudioKbps: number;
    inboundVideoKbps: number;
    outboundAudioKbps: number;
    outboundVideoKbps: number;
    packetsLost: number;
}

/**
 * Manages the full WebRTC lifecycle for a Cloudflare Calls SFU session.
 *
 * Architecture:
 *   - One RTCPeerConnection per call (SFU model -all media goes through CF).
 *   - CallSessionService owns the UI state; this service owns the WebRTC plumbing.
 *   - Effects watch the session signal to connect/disconnect and apply local state
 *     changes (mute, camera, screen share) to the peer connection.
 *   - SignalR events (via VoiceWebsocketService) drive remote participant state.
 *
 * Backend TODO summary (see individual TODOs below for details):
 *   1. POST /calls/{callId}/session                → create CF session, return cfSessionId
 *   2. POST /calls/{callId}/cf/tracks/new          → proxy to CF tracks/new
 *   3. PUT  /calls/{callId}/cf/renegotiate         → proxy to CF renegotiate
 *   4. PUT  /calls/{callId}/cf/tracks/close        → proxy to CF tracks/close
 *   5. SignalR hub: handle invocations + relay events (see voice-websocket.service.ts)
 */
@Injectable({providedIn: 'root'})
export class CallWebRtcService {
    // ── Stats polling ────────────────────────────────────────────────────────
    readonly stats = signal<CallStats | null>(null);
    // ── Connection state ──────────────────────────────────────────────────────
    private readonly pcState = signal<RTCPeerConnectionState>('new');
    private readonly engineUp = signal(false);

    /**
     * What the call UI shows as the connection state.
     *
     * This peer connection only receives now, so until the other side publishes there is nothing to
     * negotiate and it sits in `'new'` - which the call panel reads as "connecting" and would never
     * leave. Whether your voice is going out is the Rust engine's business; once the connection has
     * something to do, its own state takes over again, including its failures.
     */
    readonly rtcState = computed<RTCPeerConnectionState>(() => {
        const pc = this.pcState();
        return pc === 'new' && this.engineUp() ? 'connected' : pc;
    });
    readonly participantsWithAudio = signal<Set<string>>(new Set());
    private callSession = inject(CallSessionService);

    /**
     * Narrow views of the session, so effects wake on the value they care about rather than on
     * every rebuild of the session object. A `computed` over a boolean only notifies when the
     * boolean actually flips.
     */
    private readonly localMuted = computed(() => this.callSession.session()?.local.isMuted ?? false);
    private readonly localDeafened = computed(() => this.callSession.session()?.local.isDeafened ?? false);
    private voiceService = inject(VoiceService);
    private voiceWs = inject(VoiceWebsocketService);
    private audioSettings = inject(AudioSettingsService);
    private rustMedia = inject(RustMediaService);
    private screenPicker = inject(ScreenPickerService);
    private voiceEngine = inject(VoiceEngineService);
    private apiConfig = inject(ApiConfigService);
    private deviceIdentity = inject(DeviceIdentityService);
    private toast = inject(ToastService);
    private oauth = inject(OAuthService);
    // ── WebRTC state ─────────────────────────────────────────────────────────
    private pc: RTCPeerConnection | null = null;
    private cfSessionId: string | null = null;
    private callId: string | null = null;
    /**
     * The Rust publication carrying this call's audio.
     *
     * Held rather than looked up, because the engine now runs several calls at once and every
     * command has to say which one it means. Isle proximity voice holds its own alongside this.
     */
    private voiceSession: VoiceSession | null = null;
    private videoSender: RTCRtpSender | null = null;
    private videoTrackName: string | null = null;
    private screenSender: RTCRtpSender | null = null;
    private screenTrackName: string | null = null;
    private screenShareId: string | null = null;
    // MID → { userId, kind, shareId } -used to route ontrack events
    private readonly midMap = new Map<string, {
        userId: string;
        kind: 'audio' | 'video' | 'screen';
        shareId?: string
    }>();
    // Users already subscribed to for audio -makes subscribeToTrack('audio')
    // safe to call more than once for the same user (the live ParticipantJoined
    // event and a reconcile-on-reconnect backfill can race for the same user).
    private readonly subscribedAudioUserIds = new Set<string>();
    private prevConnState: ConnectionState | null = null;
    // Per-user volume overrides (0–1.0), persisted for the call duration
    private readonly userVolumes = new Map<string, number>();
    // ontrack events that arrived before their midMap entry was written -replayed after subscribe completes
    private readonly pendingTracks: RTCTrackEvent[] = [];

    // ── Negotiation serialisation ────────────────────────────────────────────
    // RTCPeerConnection only allows one offer/answer exchange at a time. Queuing
    // ensures publishAudioTrack and any concurrent subscribeToTrack calls never
    // ── Prev-state for change detection inside effects ───────────────────────
    private prevMuted = false;
    private prevCameraOn = false;
    private prevSharing = false;
    // race on setLocalDescription / setRemoteDescription.
    private negotiationChain: Promise<unknown> = Promise.resolve();
    // ── RxJS subscriptions to WS observables ────────────────────────────────
    private wsSubs: Subscription[] = [];
    private statsInterval?: ReturnType<typeof setInterval>;
    private prevBytes = {inAudio: 0, inVideo: 0, outAudio: 0, outVideo: 0};
    private prevStatsTs = 0;

    constructor() {
        // CallSessionService owns the preset (it also drives capture); re-apply the sender encoding
        // whenever the user changes quality mid-share.
        effect(() => {
            const preset = this.callSession.screenPreset();
            if (preset && this.screenSender) void applyScreenEncoding(this.screenSender, preset);
        });

        // Connect when a session starts; disconnect when it ends.
        effect(() => {
            const s = this.callSession.session();
            if (s && !this.callId) {
                void this.connect(s.callId);
            } else if (!s && this.callId) {
                this.disconnect();
            }
        });

        // A reconnect is the signal that any `call.*` events broadcast during
        // the gap were dropped -SignalR doesn't queue undelivered messages.
        // Re-sync authoritative state so a missed ParticipantJoined/CallEnded
        // doesn't leave us permanently out of sync.
        effect(() => {
            const cs = this.voiceWs.connectionState();
            const wasConnected = this.prevConnState === ConnectionState.Connected;
            this.prevConnState = cs;
            if (cs === ConnectionState.Connected && !wasConnected && this.callId) {
                void this.syncParticipants();
            }
        });

        // Apply local mute state + push-to-talk gate. Only the deliberate mute toggle is broadcast
        // to peers - the PTT gate is a purely local transmit gate, same as Isle proximity's syncMic.
        //
        // Both go to the Rust engine as separate facts. They used to be collapsed into one
        // `track.enabled`, which forced this effect to tiptoe around the voice-activity gate that
        // was fighting it for the same boolean; there is now exactly one gate and it lives with the
        // audio it gates.
        // Reads `localMuted`, not `session()`. Tracking the whole session object woke this on every
        // participant, speaking and camera change, and each wake fired two IPC calls into Rust.
        effect(() => {
            const isMuted = this.localMuted();
            // Mute is engine-wide - one microphone. The talk key is per call, so it names this
            // call's publication and cannot also open Isle proximity voice.
            void this.voiceEngine.setMute(isMuted);
            this.setPttOpen(this.callSession.pttGateOpen());
            if (isMuted === this.prevMuted) return;
            this.prevMuted = isMuted;
            if (this.callId) this.voiceWs.invokeMuteChange(this.callId, isMuted);
        });

        // Own speaking state, straight from the Rust gate - the same decision that picks which
        // frames are transmitted, so the indicator cannot disagree with what is actually sent.
        //
        // The session read is untracked deliberately. This effect *writes* to the session via
        // onSpeakingChanged, so tracking it would make the effect retrigger itself - an infinite
        // loop allocating a session object per pass. `speaking()` is the only thing that should
        // wake it.
        effect(() => {
            const speaking = this.voiceEngine.speaking();
            const localId = untracked(() =>
                this.callSession.session()?.participants.find(p => p.isLocal)?.userId);
            if (localId) this.callSession.onSpeakingChanged(localId, speaking);
        });

        // Apply local deafen state to every remote audio element's volume - mirrors
        // VoiceRTCService.setDeafened for the guild path. Narrowed to `localDeafened` for the same
        // reason as the mute effect above.
        effect(() => {
            void this.voiceEngine.setDeafened(this.localDeafened());
        });

        // Publish or unpublish the local camera track when the user toggles it.
        effect(() => {
            const s = this.callSession.session();
            if (!s) return;
            const isCameraOn = s.local.isCameraOn;
            if (isCameraOn === this.prevCameraOn) return;
            this.prevCameraOn = isCameraOn;
            if (isCameraOn) {
                const localP = s.participants.find(p => p.isLocal);
                if (localP?.videoStream) void this.publishVideoTrack(localP.videoStream);
            } else {
                void this.unpublishVideoTrack();
            }
        });

        // Publish or unpublish the screen share track.
        effect(() => {
            const s = this.callSession.session();
            if (!s) return;
            const isSharing = s.local.isSharing;
            if (isSharing === this.prevSharing) return;
            this.prevSharing = isSharing;
            if (isSharing) {
                const localShare = s.screenShares.find(sh => sh.isLocal);
                if (localShare?.stream) void this.publishScreenTrack(localShare.shareId, localShare.stream);
            } else {
                void this.unpublishScreenTrack();
            }
        });
    }

    // ── Connect / disconnect ──────────────────────────────────────────────────

    setUserVolume(userId: string, volume: number): void {
        const clamped = Math.max(0, Math.min(1, volume));
        this.userVolumes.set(userId, clamped);
        void this.voiceEngine.setUserVolume(userId, clamped);
    }

    getUserVolume(userId: string): number {
        return this.userVolumes.get(userId) ?? 1;
    }

    // ── SDP offer/answer cycle ────────────────────────────────────────────────

    // Serialise all SDP exchanges through a promise chain so concurrent publish

    private async connect(callId: string): Promise<void> {
        this.callId = callId; // Set immediately so re-entry is prevented

        // CF Calls SFU has a publicly routable server -no STUN/TURN needed.
        // bundlePolicy: 'max-bundle' is required by Cloudflare Calls.
        this.pc = new RTCPeerConnection({bundlePolicy: 'max-bundle'});
        (window as any).__pc = this.pc;  // ← add this line
        this.pc.ontrack = (e) => this.handleRemoteTrack(e);
        this.pc.onconnectionstatechange = () => {
            if (this.pc) this.pcState.set(this.pc.connectionState);
        };

        // TODO(backend): Implement POST /api/v1/messaging/voice/calls/{callId}/session.
        // Steps on the server:
        //   1. POST to CF: https://rtc.live.cloudflare.com/v1/apps/{APP_ID}/sessions/new
        //      with header: Authorization: Bearer {APP_SECRET}  (no request body needed)
        //   2. Store the returned sessionId in your DB as the CF session for this user in this call.
        //   3. Respond to the client with: { cfSessionId: string }
        //   4. Emit 'ParticipantJoined' via SignalR to all OTHER call members with:
        //        { userId, cfSessionId, audioTrackName: 'audio' }
        //      (you'll need to emit this AFTER the client publishes their audio track -see cfTracksNew)
        // Secondary: the Rust session started below carries this participant's microphone, and a
        // second primary session for the same user reads as a device takeover and ends the call.
        const {cfSessionId} = await firstValueFrom(this.voiceService.cfCreateSession(callId, false));
        if (!this.callId) return;
        this.cfSessionId = cfSessionId;

        // Set up WS listeners NOW -cfSessionId is ready and we need to be subscribed before the
        // Rust session's publish triggers ExchangeParticipantJoined on the server, which sends
        // ParticipantJoined back to us for any already-connected participants.
        this.setupWsListeners();

        // Backfill in case that ExchangeParticipantJoined re-notify is ever missed (e.g.
        // joining a group call already in progress right as a signaling gap opens) -
        // subscribeToTrack's dedupe guard makes this safe to race with the WS listener.
        void this.syncParticipants();

        // The microphone is captured, processed and published entirely in Rust, on its own
        // Cloudflare session opened with primary=true. Nothing is added to this peer connection;
        // the other side resolves the track from the ParticipantJoined event the backend emits when
        // that session publishes "audio", and it carries the Rust session id.
        try {
            this.voiceSession = await this.voiceEngine.start(
                {kind: 'call', callId},
                this.apiConfig.baseUrl(),
                this.oauth.getAccessToken(),
                await this.deviceIdentity.deviceId(),
            );
        } catch (e) {
            console.error('[WebRTC] Rust voice engine failed to start -joining without audio', e);
            return;
        }
        if (!this.callId) {
            void this.voiceEngine.stop(this.voiceSession);
            this.voiceSession = null;
            return;
        }
        this.engineUp.set(true);

        // Apply current mute state immediately - the user may have muted before connecting, and the
        // engine starts with its talk key up, which in push-to-talk mode means the gate is shut.
        const isMuted = this.callSession.session()?.local.isMuted ?? false;
        this.prevMuted = isMuted;
        void this.voiceEngine.setMute(isMuted);
        this.setPttOpen(this.callSession.pttGateOpen());

        this.startStatsPolling();
    }

    /** Open or close the microphone for this call, leaving any other call's routing alone. */
    private setPttOpen(open: boolean): void {
        if (this.voiceSession) void this.voiceEngine.setPttOpen(this.voiceSession, open);
    }

    /** Drop a source from this call's publication. Null-safe: WS events outlive the call. */
    private async dropSource(id: string): Promise<void> {
        if (this.voiceSession) await this.voiceEngine.unsubscribe(this.voiceSession, id);
    }

    private disconnect(): void {
        this.stopStatsPolling();
        // Only this call. Isle proximity voice may be running on the same microphone and must
        // survive hanging up.
        if (this.voiceSession) void this.voiceEngine.stop(this.voiceSession);
        this.voiceSession = null;
        this.engineUp.set(false);
        void this.rustMedia.stopScreenCapture();
        this.pc?.close();
        this.wsSubs.forEach(s => s.unsubscribe());

        this.pcState.set('new');
        this.participantsWithAudio.set(new Set());
        this.pc = null;
        this.cfSessionId = null;
        this.callId = null;
        this.videoSender = null;
        this.videoTrackName = null;
        this.screenSender = null;
        this.screenTrackName = null;
        this.screenShareId = null;
        this.midMap.clear();
        this.userVolumes.clear();
        this.subscribedAudioUserIds.clear();
        this.pendingTracks.length = 0;
        this.negotiationChain = Promise.resolve();
        this.wsSubs = [];
        this.prevMuted = false;
        this.prevCameraOn = false;
        this.prevSharing = false;
    }

    // ── Local track publishing ────────────────────────────────────────────────

    // and subscribe calls never race on setLocalDescription/setRemoteDescription.
    private offerAnswerCycle(buildTracks: () => CfTrackNew[]): Promise<CfTrackResult[]> {
        const next = this.negotiationChain
            .catch(() => void 0)
            .then(() => this.doOfferAnswer(buildTracks));
        this.negotiationChain = next.catch(() => void 0);
        return next;
    }

    private async doOfferAnswer(buildTracks: () => CfTrackNew[]): Promise<CfTrackResult[]> {
        if (!this.pc || !this.cfSessionId || !this.callId) return [];

        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        if (!this.callId) return [];

        // TODO(backend): Implement POST /api/v1/messaging/voice/calls/{callId}/cf/tracks/new.
        // Request body: { cfSessionId, sessionDescription: { type, sdp }, tracks: [...] }
        // Proxy to CF: POST https://rtc.live.cloudflare.com/v1/apps/{APP_ID}/sessions/{cfSessionId}/tracks/new
        // Return the CF response as-is:
        //   { sessionDescription: { type, sdp }, tracks: [{ mid, trackName, ... }], requiresImmediateRenegotiation }
        // If the published track is a new audio track (kind='audio'), after success:
        //   emit 'ParticipantJoined' SignalR event to other call members with the user's cfSessionId.
        // If the published track is video or screen, emit 'TrackPublished' to other call members:
        //   { userId, cfSessionId, trackName, kind: 'video'|'screen', shareId? }
        const response = await firstValueFrom(
            this.voiceService.cfTracksNew(this.callId, this.cfSessionId, {
                sessionDescription: offer,
                tracks: buildTracks(),
            })
        );
        if (!this.callId) return [];

        await this.setRemoteDescriptionOrThrow(response.sessionDescription, 'tracks/new');

        if (response.requiresImmediateRenegotiation) {
            // CF needs a fresh offer now that it has set up the remote tracks
            const reOffer = await this.pc.createOffer();
            await this.pc.setLocalDescription(reOffer);
            if (!this.callId) return [];

            // TODO(backend): Implement PUT /api/v1/messaging/voice/calls/{callId}/cf/renegotiate.
            // Request body: { cfSessionId, sessionDescription: { type, sdp } }
            // Proxy to CF: PUT https://rtc.live.cloudflare.com/v1/apps/{APP_ID}/sessions/{cfSessionId}/renegotiate
            // Return CF response: { sessionDescription: { type, sdp } }
            const renegResponse = await firstValueFrom(
                this.voiceService.cfRenegotiate(this.callId, this.cfSessionId, reOffer)
            );
            if (!this.callId) return [];
            await this.setRemoteDescriptionOrThrow(renegResponse.sessionDescription, 'renegotiate');
        }

        return response.tracks ?? [];
    }

    /**
     * setRemoteDescription with the sessionDescription's content logged on failure.
     * That description comes verbatim from the backend's Cloudflare Calls proxy, not
     * from this client, so a parse failure here means the backend/CF response was
     * malformed before it ever reached us -there is nothing to munge or retry
     * client-side. This only makes the next occurrence diagnosable instead of
     * surfacing as a bare browser-internal parse error.
     */
    private async setRemoteDescriptionOrThrow(desc: RTCSessionDescriptionInit, stage: string): Promise<void> {
        if (!this.pc) return;
        try {
            await this.pc.setRemoteDescription(desc);
        } catch (e) {
            console.error(`[WebRTC] setRemoteDescription failed at ${stage}:`, e, {
                type: desc?.type,
                sdpLength: desc?.sdp?.length ?? 0,
                sdpPreview: desc?.sdp?.slice(0, 500),
            });
            throw e;
        }
    }

    private async publishVideoTrack(stream: MediaStream): Promise<void> {
        if (!this.pc || !this.callId) return;
        const track = stream.getVideoTracks()[0];
        if (!track) return;
        const transceiver = this.pc.addTransceiver(track, {direction: 'sendonly'});
        const results = await this.offerAnswerCycle(() => [{
            location: 'local',
            mid: transceiver.mid ?? '0',
            trackName: 'video',
        }]);
        this.videoSender = transceiver.sender;
        this.videoTrackName = results[0]?.trackName ?? 'video';
        await applySimpleBitrate(transceiver.sender, CAMERA_KBPS);
        if (this.callId) this.voiceWs.invokeCameraChanged(this.callId, true);
    }

    private async unpublishVideoTrack(): Promise<void> {
        if (!this.pc || !this.callId) return;
        const trackName = this.videoTrackName ?? 'video';
        if (this.videoSender) {
            this.pc.removeTrack(this.videoSender);
            this.videoSender = null;
        }
        this.videoTrackName = null;

        if (this.cfSessionId) {
            // TODO(backend): Implement PUT /api/v1/messaging/voice/calls/{callId}/cf/tracks/close.
            // Request body: { cfSessionId, trackNames: string[] }
            // Proxy to CF: PUT .../sessions/{cfSessionId}/tracks/close
            //   with body: { tracks: [{ trackName }] }
            // Emit 'TrackClosed' SignalR event to other call members after closing.
            await firstValueFrom(
                this.voiceService.cfCloseTracks(this.callId, this.cfSessionId, [trackName])
            ).catch(() => void 0);
        }
        if (this.callId) this.voiceWs.invokeCameraChanged(this.callId, false);
    }

    // ── Remote track subscription ─────────────────────────────────────────────

    private async publishScreenTrack(shareId: string, stream: MediaStream): Promise<void> {
        if (!this.pc || !this.callId) return;
        const track = stream.getVideoTracks()[0];
        if (!track) return;
        const transceiver = this.pc.addTransceiver(track, {direction: 'sendonly'});

        // Prefer VP9 for screen sharing -better quality-per-bit means higher effective fps
        // at the same bitrate compared to VP8.
        preferVideoCodecs(transceiver, 'sender');

        const cfTrackName = `screen-${shareId}`;
        const results = await this.offerAnswerCycle(() => [{
            location: 'local',
            mid: transceiver.mid ?? '0',
            trackName: cfTrackName,
        }]);
        this.screenSender = transceiver.sender;
        this.screenTrackName = results[0]?.trackName ?? cfTrackName;
        this.screenShareId = shareId;
        await applyScreenEncoding(transceiver.sender, this.callSession.screenPreset() ?? DEFAULT_STREAM_PRESET);
        if (this.callId) this.voiceWs.invokeScreenShareStarted(this.callId, shareId, this.screenTrackName);
    }

    private async unpublishScreenTrack(): Promise<void> {
        if (!this.pc || !this.callId) return;
        const trackName = this.screenTrackName ?? '';
        const shareId = this.screenShareId ?? '';
        if (this.screenSender) {
            this.pc.removeTrack(this.screenSender);
            this.screenSender = null;
        }
        this.screenTrackName = null;
        this.screenShareId = null;

        if (this.cfSessionId && trackName) {
            await firstValueFrom(
                this.voiceService.cfCloseTracks(this.callId, this.cfSessionId, [trackName])
            ).catch(() => void 0);
        }
        if (shareId && this.callId) this.voiceWs.invokeScreenShareStopped(this.callId, shareId);
    }

    // ── Remote track routing ──────────────────────────────────────────────────

    private async subscribeToTrack(
        userId: string,
        remoteCfSessionId: string,
        trackName: string,
        kind: 'audio' | 'video' | 'screen',
        shareId?: string,
    ): Promise<void> {
        if (kind === 'audio') {
            if (this.subscribedAudioUserIds.has(userId)) return;
            const session = this.voiceSession;
            if (!session) return;
            this.subscribedAudioUserIds.add(userId);

            // Audio never touches this peer connection now: it is pulled onto the Rust session,
            // decoded and mixed there, and played through the output device Rust owns.
            try {
                await this.voiceEngine.subscribe(session, userId, remoteCfSessionId, trackName);
                this.participantsWithAudio.update(s => {
                    const n = new Set(s);
                    n.add(userId);
                    return n;
                });
                const volume = this.userVolumes.get(userId);
                if (volume !== undefined) await this.voiceEngine.setUserVolume(userId, volume);
            } catch (e) {
                console.error('[WebRTC] audio subscribe failed', {userId, trackName}, e);
                // Roll the guard back, exactly as the video path does below: every retry route -
                // live ParticipantJoined, the syncParticipants backfill, the reconnect resync - is
                // gated behind it, so leaving it consumed makes one failure permanent.
                this.subscribedAudioUserIds.delete(userId);
            }
            return;
        }
        if (!this.pc) return;
        // Everything below is a network round trip (or more than one, via CF
        // renegotiation) that can throw or transiently fail -most likely on a cold
        // app start (fresh CF session, cold DNS/TLS). If we don't roll back the
        // dedupe guard above on failure, this user's audio is silently dead for
        // the rest of the call: every other path that could retry (live
        // ParticipantJoined, syncParticipants backfill, reconnect resync) is
        // gated behind the same subscribedAudioUserIds check, so a single failed
        // attempt here would have zero chance of ever being retried.
        try {
            console.log('[WebRTC] subscribeToTrack', {userId, remoteCfSessionId, trackName, kind});
            // Only video reaches this connection now; audio returned above.
            const transceiver = this.pc.addTransceiver('video', {direction: 'recvonly'});
            preferVideoCodecs(transceiver, 'receiver');

            const results = await this.offerAnswerCycle(() => [{
                location: 'remote',
                sessionId: remoteCfSessionId,
                trackName,
            }]);
            console.log('[WebRTC] subscribeToTrack results', results);

            // Only Cloudflare's own mid can route this track. Falling back to `transceiver.mid`
            // (as this used to) invents a mid for a subscription Cloudflare never set up: the
            // entry goes into midMap, no media ever arrives on it, and because the dedupe guard
            // above is left consumed, the live ParticipantJoined / syncParticipants / reconnect
            // resync paths that could retry are all short-circuited. That is the "No audio
            // received from this participant" state, and it lasted the whole call.
            const mid = results.find(r => r.trackName === trackName)?.mid;
            if (!mid) {
                throw new Error(
                    `Cloudflare returned no mid for ${kind} track "${trackName}" on session ${remoteCfSessionId}`);
            }
            console.log('[WebRTC] midMap set', mid, '→', {userId, kind});
            this.midMap.set(mid, {userId, kind, shareId});
            this.processPendingTracks();
        } catch (e) {
            console.error('[WebRTC] subscribeToTrack failed', {userId, trackName, kind}, e);
        }
    }

    // ── Per-user volume control ───────────────────────────────────────────────

    private processPendingTracks(): void {
        const remaining: RTCTrackEvent[] = [];
        for (const event of this.pendingTracks) {
            const mid = event.transceiver.mid;
            if (mid && this.midMap.has(mid)) {
                this.handleRemoteTrack(event);
            } else {
                remaining.push(event);
            }
        }
        this.pendingTracks.length = 0;
        this.pendingTracks.push(...remaining);
    }

    private handleRemoteTrack(event: RTCTrackEvent): void {
        const mid = event.transceiver.mid;
        console.log('[WebRTC] ontrack', {mid, kind: event.track.kind, midMapKeys: [...this.midMap.keys()]});
        if (!mid) return;
        const info = this.midMap.get(mid);
        if (!info) {
            this.pendingTracks.push(event);
            return;
        }

        const stream = event.streams[0] ?? new MediaStream([event.track]);

        // No audio branch: audio is mixed and played in Rust, and never routed here.
        if (info.kind === 'video') {
            this.callSession.onCameraChanged(info.userId, true, stream);
            event.track.onended = () => this.callSession.onCameraChanged(info.userId, false);
        } else if (info.kind === 'screen' && info.shareId) {
            this.callSession.onScreenShareStarted(info.shareId, info.userId, stream);
            event.track.onended = () => this.callSession.onScreenShareStopped(info.shareId!);
        }
    }

    // ── Stats polling ─────────────────────────────────────────────────────────

    private startStatsPolling(): void {
        this.prevBytes = {inAudio: 0, inVideo: 0, outAudio: 0, outVideo: 0};
        this.prevStatsTs = 0;
        this.statsInterval = setInterval(() => void this.pollStats(), 2000);
    }

    private stopStatsPolling(): void {
        clearInterval(this.statsInterval);
        this.statsInterval = undefined;
        this.stats.set(null);
        this.prevStatsTs = 0;
    }

    private async pollStats(): Promise<void> {
        if (!this.pc) return;
        const report = await this.pc.getStats();
        const now = Date.now();

        let inAudio = 0, inVideo = 0, outAudio = 0, outVideo = 0, packetsLost = 0;
        report.forEach((stat: RTCStats) => {
            if (stat.type === 'inbound-rtp') {
                const s = stat as RTCInboundRtpStreamStats;
                if (s.kind === 'audio') inAudio += s.bytesReceived ?? 0;
                else inVideo += s.bytesReceived ?? 0;
                packetsLost += s.packetsLost ?? 0;
            } else if (stat.type === 'outbound-rtp') {
                const s = stat as RTCOutboundRtpStreamStats;
                if (s.kind === 'audio') outAudio += s.bytesSent ?? 0;
                else outVideo += s.bytesSent ?? 0;
            }
        });

        if (!this.prevStatsTs) {
            this.prevBytes = {inAudio, inVideo, outAudio, outVideo};
            this.prevStatsTs = now;
            return;
        }

        const dt = (now - this.prevStatsTs) / 1000;
        const kbps = (cur: number, prev: number) =>
            Math.max(0, Math.round(((cur - prev) * 8) / dt / 1000));

        this.stats.set({
            inboundKbps: kbps(inAudio + inVideo, this.prevBytes.inAudio + this.prevBytes.inVideo),
            outboundKbps: kbps(outAudio + outVideo, this.prevBytes.outAudio + this.prevBytes.outVideo),
            inboundAudioKbps: kbps(inAudio, this.prevBytes.inAudio),
            inboundVideoKbps: kbps(inVideo, this.prevBytes.inVideo),
            outboundAudioKbps: kbps(outAudio, this.prevBytes.outAudio),
            outboundVideoKbps: kbps(outVideo, this.prevBytes.outVideo),
            packetsLost,
        });

        this.prevBytes = {inAudio, inVideo, outAudio, outVideo};
        this.prevStatsTs = now;
    }


    // ── Authoritative state reconciliation ────────────────────────────────────

    /**
     * Fetches the current call state and reconciles: subscribes to any
     * participant's audio track we never heard about (subscribeToTrack's
     * dedupe guard makes this safe against a live event having already
     * handled it), removes participants who are no longer in the call, and
     * hangs up locally if the call ended -or we were removed- while we
     * weren't listening. Called once at connect() (covers joining a call
     * already in progress) and on every SignalR reconnect (covers events
     * dropped during the gap, since SignalR doesn't queue undelivered
     * messages for a lapsed connection).
     */
    private async syncParticipants(): Promise<void> {
        const callId = this.callId;
        if (!callId) return;

        let fresh: CallDto;
        try {
            fresh = await firstValueFrom(this.voiceService.getCall(callId));
        } catch {
            return; // Best-effort - a later reconnect or live event will catch up.
        }
        if (this.callId !== callId) return; // Call ended/changed while the request was in flight

        const s = this.callSession.session();
        if (!s) return;
        const ownId = s.participants.find(p => p.isLocal)?.userId;

        if (fresh.status === 'Completed' || fresh.status === 'Rejected') {
            this.callSession.end();
            return;
        }
        // ownId can be unresolved this early if profileService.ownProfile()
        // hadn't loaded yet when join() computed isLocal (every participant
        // then reads isLocal: false). Treating "no participant matches
        // undefined" as "I was removed" would hang up a call that's actually
        // fine - only act on this check once ownId is actually known.
        if (ownId && !fresh.participants.some(p => p.userId === ownId)) {
            this.callSession.end();
            return;
        }

        const freshIds = new Set(fresh.participants.map(p => p.userId));
        for (const p of s.participants) {
            if (!p.isLocal && !freshIds.has(p.userId)) {
                this.callSession.onParticipantLeft(p.userId);
                this.subscribedAudioUserIds.delete(p.userId);
                void this.dropSource(p.userId);
            }
        }

        for (const p of fresh.participants) {
            if (p.userId === ownId || !p.cfSessionId || !p.audioTrackName) continue;
            this.callSession.onParticipantJoined(p.userId);
            void this.subscribeToTrack(p.userId, p.cfSessionId, p.audioTrackName, 'audio');
        }
    }

    // ── SignalR event listeners ───────────────────────────────────────────────

    private setupWsListeners(): void {
        this.wsSubs = [
            // Someone joined → add to UI and subscribe to their audio track
            this.voiceWs.participantJoinedObservable.subscribe(e => {
                console.log('[WebRTC] ParticipantJoined received in WS listener', e);
                this.callSession.onParticipantJoined(e.userId);
                // Same guard the track-published listener below has carried all along, and for the
                // same reason: since audio moved to its own Rust session this event names the session
                // we publish on, and Cloudflare refuses to let a session pull its own local track.
                // The backfill in syncParticipants already skips ownId; this path did not.
                const localId = this.callSession.session()?.participants.find(p => p.isLocal)?.userId;
                if (e.userId === localId) return;
                void this.subscribeToTrack(e.userId, e.cfSessionId, e.audioTrackName, 'audio');
            }),

            // Someone left → remove from UI (tracks will auto-end via onended)
            this.voiceWs.participantLeftObservable.subscribe(e => {
                this.callSession.onParticipantLeft(e.userId);
                this.subscribedAudioUserIds.delete(e.userId);
                // Drop their source, or they keep a slot in the mixer that is popped and mixed on
                // every frame for the rest of the call.
                void this.dropSource(e.userId);
                this.participantsWithAudio.update(s => {
                    const n = new Set(s);
                    n.delete(e.userId);
                    return n;
                });
            }),

            // New video / screen track published → subscribe to it
            this.voiceWs.trackPublishedObservable.subscribe(e => {
                const localId = this.callSession.session()?.participants.find(p => p.isLocal)?.userId;
                if (e.userId === localId) return; // Skip own tracks
                if (e.kind === 'video') {
                    void this.subscribeToTrack(e.userId, e.cfSessionId, e.trackName, 'video');
                } else if (e.kind === 'screen') {
                    void this.subscribeToTrack(e.userId, e.cfSessionId, e.trackName, 'screen', e.shareId);
                }
            }),

            // Remote mute/speaking/camera state changes
            this.voiceWs.muteChangedObservable.subscribe(e =>
                this.callSession.onMuteChanged(e.userId, e.isMuted)),

            this.voiceWs.speakingChangedObservable.subscribe(e =>
                this.callSession.onSpeakingChanged(e.userId, e.isSpeaking)),

            this.voiceWs.cameraChangedObservable.subscribe(e => {
                // Turn-off: update UI immediately (track.onended handles stream cleanup)
                if (!e.isCameraOn) this.callSession.onCameraChanged(e.userId, false);
                // Turn-on: handled by trackPublishedObservable → subscribeToTrack → ontrack → onCameraChanged
            }),

            // Screen share start: surface in UI immediately (stream arrives via ontrack)
            this.voiceWs.screenShareStartedObservable.subscribe(e => {
                this.callSession.onScreenShareStarted(e.shareId, e.userId, undefined);
            }),

            this.voiceWs.screenShareStoppedObservable.subscribe(e =>
                this.callSession.onScreenShareStopped(e.shareId)),

            // Application-level departure. Handled alongside - not instead of - the WebRTC-level
            // `call.ParticipantLeft`: onParticipantLeft is an idempotent array filter, so both
            // firing for one departure is harmless, and which of the two the backend keeps once
            // this ships is not knowable from here.
            this.voiceWs.callParticipantLeftObservable.subscribe(e => {
                this.callSession.onParticipantLeft(e.userId);
                this.subscribedAudioUserIds.delete(e.userId);
                void this.dropSource(e.userId);
                this.participantsWithAudio.update(s => {
                    const n = new Set(s);
                    n.delete(e.userId);
                    return n;
                });
            }),

            // Everyone else left; the server will force-end the call at this deadline.
            this.voiceWs.callAloneObservable.subscribe(e => {
                if (e.callId !== this.callId) return;
                this.callSession.setAloneDeadline(new Date(e.deadline));
            }),

            // The call ended for someone else's reason - the server has already torn it down.
            this.voiceWs.callEndedObservable.subscribe(e => {
                // `wasActive` is what keeps a self-initiated hangup silent: clicking hang up
                // nulls session() synchronously, before any CallEnded broadcast can arrive. So
                // this only speaks up when the call ended for a reason the user did not cause.
                const wasActive = !!this.callSession.session();
                this.callSession.end(true);
                if (wasActive) this.toast.info(describeCallEndedReason(e.reason));
            }),
        ];
    }
}
