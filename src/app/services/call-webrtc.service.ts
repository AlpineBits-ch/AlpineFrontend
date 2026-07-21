import {effect, inject, Injectable, signal} from '@angular/core';
import {firstValueFrom, Subscription} from 'rxjs';
import {CallSessionService} from './call-session.service';
import {CfTrackNew, CfTrackResult, VoiceService} from './voice.service';
import {VoiceWebsocketService} from './voice-websocket.service';
import {AudioSettingsService} from './audio-settings.service';
import {RustMediaService} from './rust-media.service';
import {ScreenPickerService} from './screen-picker.service';

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
    readonly rtcState = signal<RTCPeerConnectionState>('new');
    readonly participantsWithAudio = signal<Set<string>>(new Set());
    private callSession = inject(CallSessionService);
    private voiceService = inject(VoiceService);
    private voiceWs = inject(VoiceWebsocketService);
    private audioSettings = inject(AudioSettingsService);
    private rustMedia = inject(RustMediaService);
    private screenPicker = inject(ScreenPickerService);
    // ── WebRTC state ─────────────────────────────────────────────────────────
    private pc: RTCPeerConnection | null = null;
    private cfSessionId: string | null = null;
    private callId: string | null = null;
    private audioTrack: MediaStreamTrack | null = null;
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
    // Audio elements for remote participants -WebView2/Tauri requires explicit <audio> elements
    private readonly remoteAudio = new Map<string, HTMLAudioElement>();
    // Local senders stored for on-the-fly bitrate updates
    private audioSender: RTCRtpSender | null = null;
    // Per-user volume overrides (0–1.0), persisted for the call duration
    private readonly userVolumes = new Map<string, number>();
    // ontrack events that arrived before their midMap entry was written -replayed after subscribe completes
    private readonly pendingTracks: RTCTrackEvent[] = [];
    // ── Speaking detection ───────────────────────────────────────────────────
    private audioCtx: AudioContext | null = null;
    private rafHandle: number | null = null;
    private lastSpeaking = false;
    private readonly SPEAKING_THRESHOLD = 0.02;

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
        // Apply bitrate changes on the fly whenever settings change.
        effect(() => {
            const s = this.audioSettings.settings();
            void this.applyBitrate(this.audioSender, s.audioBitrate);
            void this.applyBitrate(this.videoSender, s.videoBitrate);
            void this.applyBitrate(this.screenSender, s.screenVideoBitrate);
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

        // Apply local mute state to the audio track and notify peers.
        effect(() => {
            const s = this.callSession.session();
            if (!s) return;
            const isMuted = s.local.isMuted;
            if (isMuted === this.prevMuted) return;
            this.prevMuted = isMuted;
            if (this.audioTrack) this.audioTrack.enabled = !isMuted;
            if (this.callId) this.voiceWs.invokeMuteChange(this.callId, isMuted);
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
        const audio = this.remoteAudio.get(userId);
        if (audio) audio.volume = clamped;
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
            if (this.pc) this.rtcState.set(this.pc.connectionState);
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
        const {cfSessionId} = await firstValueFrom(this.voiceService.cfCreateSession(callId));
        if (!this.callId) return;
        this.cfSessionId = cfSessionId;

        // Set up WS listeners NOW -cfSessionId is ready and we need to be subscribed before
        // publishAudioTrack triggers ExchangeParticipantJoined on the server, which sends
        // ParticipantJoined back to us for any already-connected participants.
        this.setupWsListeners();

        // Acquire microphone -use Rust pipeline when enhanced NS is on
        let audioTrack: MediaStreamTrack;
        try {
            const s = this.audioSettings.settings();
            if (s.enhancedNoiseSuppression || await this.rustMedia.shouldUseRustAudio()) {
                audioTrack = await this.rustMedia.startMicCapture({
                    deviceId: s.micId === 'default' ? null : s.micId,
                    noiseSuppression: s.noiseSuppression,
                    autoGainControl: s.autoGainControl,
                    vadThreshold: s.vadStrength,
                });
            } else {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: this.audioSettings.buildAudioConstraint(),
                    video: false,
                });
                audioTrack = stream.getAudioTracks()[0];
            }
        } catch {
            console.warn('[WebRTC] Microphone access denied -joining without audio');
            return;
        }
        if (!this.callId) {
            audioTrack.stop();
            return;
        }

        this.audioTrack = audioTrack;
        // Apply current mute state immediately (user may have muted before connecting)
        const isMuted = this.callSession.session()?.local.isMuted ?? false;
        this.audioTrack.enabled = !isMuted;
        this.prevMuted = isMuted;

        await this.publishAudioTrack(this.audioTrack);
        if (!this.callId) return;

        this.startSpeakingDetection(new MediaStream([this.audioTrack]));
        this.startStatsPolling();
    }

    private disconnect(): void {
        if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
        this.stopStatsPolling();
        this.audioCtx?.close().catch(() => void 0);
        this.audioTrack?.stop();
        void this.rustMedia.stopMicCapture();
        void this.rustMedia.stopScreenCapture();
        this.pc?.close();
        this.remoteAudio.forEach(a => {
            a.pause();
            a.srcObject = null;
        });
        this.remoteAudio.clear();
        this.audioSender = null;
        this.wsSubs.forEach(s => s.unsubscribe());

        this.rtcState.set('new');
        this.participantsWithAudio.set(new Set());
        this.pc = null;
        this.cfSessionId = null;
        this.callId = null;
        this.audioTrack = null;
        this.audioCtx = null;
        this.rafHandle = null;
        this.videoSender = null;
        this.videoTrackName = null;
        this.screenSender = null;
        this.screenTrackName = null;
        this.screenShareId = null;
        this.midMap.clear();
        this.userVolumes.clear();
        this.pendingTracks.length = 0;
        this.negotiationChain = Promise.resolve();
        this.wsSubs = [];
        this.lastSpeaking = false;
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

        await this.pc.setRemoteDescription(response.sessionDescription);

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
            await this.pc.setRemoteDescription(renegResponse.sessionDescription);
        }

        return response.tracks ?? [];
    }

    private async publishAudioTrack(track: MediaStreamTrack): Promise<void> {
        if (!this.pc) return;
        const transceiver = this.pc.addTransceiver(track, {direction: 'sendonly'});
        await this.offerAnswerCycle(() => [{
            location: 'local',
            mid: transceiver.mid ?? '0',
            trackName: 'audio',
        }]);
        await this.applyBitrate(transceiver.sender, this.audioSettings.settings().audioBitrate);
        this.audioSender = transceiver.sender;
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
        await this.applyBitrate(transceiver.sender, this.audioSettings.settings().videoBitrate);
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
        const caps = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
        const ordered = [
            ...caps.filter(c => c.mimeType === 'video/VP9'),
            ...caps.filter(c => c.mimeType === 'video/H264'),
            ...caps.filter(c => c.mimeType !== 'video/VP9' && c.mimeType !== 'video/H264'),
        ];
        if (ordered.length) try {
            transceiver.setCodecPreferences(ordered);
        } catch {
        }

        const cfTrackName = `screen-${shareId}`;
        const results = await this.offerAnswerCycle(() => [{
            location: 'local',
            mid: transceiver.mid ?? '0',
            trackName: cfTrackName,
        }]);
        this.screenSender = transceiver.sender;
        this.screenTrackName = results[0]?.trackName ?? cfTrackName;
        this.screenShareId = shareId;
        const fps = this.audioSettings.settings().screenVideoBitrate >= 8000 ? 30 : 15;
        await this.applyBitrate(transceiver.sender, this.audioSettings.settings().screenVideoBitrate, 1.0, fps);
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
        if (!this.pc) return;
        console.log('[WebRTC] subscribeToTrack', {userId, remoteCfSessionId, trackName, kind});
        const mediaKind = kind === 'audio' ? 'audio' : 'video';
        const transceiver = this.pc.addTransceiver(mediaKind, {direction: 'recvonly'});

        // For video/screen tracks, prefer VP9 on the receive side for the same efficiency gains.
        if (mediaKind === 'video') {
            const caps = RTCRtpReceiver.getCapabilities('video')?.codecs ?? [];
            const ordered = [
                ...caps.filter(c => c.mimeType === 'video/VP9'),
                ...caps.filter(c => c.mimeType === 'video/H264'),
                ...caps.filter(c => c.mimeType !== 'video/VP9' && c.mimeType !== 'video/H264'),
            ];
            if (ordered.length) try {
                transceiver.setCodecPreferences(ordered);
            } catch {
            }
        }

        const results = await this.offerAnswerCycle(() => [{
            location: 'remote',
            sessionId: remoteCfSessionId,
            trackName,
        }]);
        console.log('[WebRTC] subscribeToTrack results', results);

        // Map the MID (from CF response or our transceiver) so handleRemoteTrack can route it
        const mid = results.find(r => r.trackName === trackName)?.mid ?? transceiver.mid;
        console.log('[WebRTC] midMap set', mid, '→', {userId, kind});
        if (mid) {
            this.midMap.set(mid, {userId, kind, shareId});
            this.processPendingTracks();
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

        if (info.kind === 'audio') {
            const existing = this.remoteAudio.get(info.userId);
            if (existing) {
                existing.pause();
                existing.srcObject = null;
            }

            const element = new Audio();
            element.srcObject = stream;
            element.autoplay = true;
            element.volume = this.userVolumes.get(info.userId) ?? 1;
            const speakerId = this.audioSettings.settings().speakerId;
            if (speakerId && speakerId !== 'default' && typeof (element as any).setSinkId === 'function') {
                (element as any).setSinkId(speakerId).catch(() => void 0);
            }
            void element.play().catch(() => {
            });

            this.remoteAudio.set(info.userId, element);
            this.participantsWithAudio.update(s => {
                const n = new Set(s);
                n.add(info.userId);
                return n;
            });

            event.track.onended = () => {
                const el = this.remoteAudio.get(info.userId);
                if (el) {
                    el.pause();
                    el.srcObject = null;
                    this.remoteAudio.delete(info.userId);
                }
                this.participantsWithAudio.update(s => {
                    const n = new Set(s);
                    n.delete(info.userId);
                    return n;
                });
            };
        } else if (info.kind === 'video') {
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

    // ── Bitrate control ───────────────────────────────────────────────────────

    private async applyBitrate(sender: RTCRtpSender | null, kbps: number, scaleResolutionDownBy?: number, maxFps?: number): Promise<void> {
        if (!sender) return;
        try {
            const params = sender.getParameters();
            if (!params.encodings?.length) params.encodings = [{}];
            params.encodings[0].maxBitrate = kbps * 1000;
            if (scaleResolutionDownBy !== undefined) params.encodings[0].scaleResolutionDownBy = scaleResolutionDownBy;
            if (maxFps !== undefined) params.encodings[0].maxFramerate = maxFps;
            await sender.setParameters(params);
        } catch { /* setParameters not supported or call already ended */
        }
    }

    // ── Speaking detection (local) ────────────────────────────────────────────

    private startSpeakingDetection(stream: MediaStream): void {
        try {
            this.audioCtx = new AudioContext();
            const source = this.audioCtx.createMediaStreamSource(stream);
            const analyser = this.audioCtx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);

            const data = new Float32Array(analyser.fftSize);
            const tick = () => {
                analyser.getFloatTimeDomainData(data);
                const rms = Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length);
                const speaking = rms > this.SPEAKING_THRESHOLD;
                if (speaking !== this.lastSpeaking) {
                    this.lastSpeaking = speaking;
                    const s = this.callSession.session();
                    const localId = s?.participants.find(p => p.isLocal)?.userId;
                    if (localId) this.callSession.onSpeakingChanged(localId, speaking);
                }
                this.rafHandle = requestAnimationFrame(tick);
            };
            this.rafHandle = requestAnimationFrame(tick);
        } catch {
            // AudioContext unavailable
        }
    }

    // ── SignalR event listeners ───────────────────────────────────────────────

    private setupWsListeners(): void {
        this.wsSubs = [
            // Someone joined → add to UI and subscribe to their audio track
            this.voiceWs.participantJoinedObservable.subscribe(e => {
                console.log('[WebRTC] ParticipantJoined received in WS listener', e);
                this.callSession.onParticipantJoined(e.userId);
                void this.subscribeToTrack(e.userId, e.cfSessionId, e.audioTrackName, 'audio');
            }),

            // Someone left → remove from UI (tracks will auto-end via onended)
            this.voiceWs.participantLeftObservable.subscribe(e => {
                this.callSession.onParticipantLeft(e.userId);
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

            // Host ended the call
            this.voiceWs.callEndedObservable.subscribe(() => {
                this.callSession.end();
            }),
        ];
    }
}
