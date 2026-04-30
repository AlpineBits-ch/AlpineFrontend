import { effect, inject, Injectable } from '@angular/core';
import { firstValueFrom, Subscription } from 'rxjs';
import { CallSessionService } from './call-session.service';
import { VoiceService, CfTrackNew, CfTrackResult } from './voice.service';
import { VoiceWebsocketService } from './voice-websocket.service';
import { AudioSettingsService } from './audio-settings.service';

/**
 * Manages the full WebRTC lifecycle for a Cloudflare Calls SFU session.
 *
 * Architecture:
 *   - One RTCPeerConnection per call (SFU model — all media goes through CF).
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
@Injectable({ providedIn: 'root' })
export class CallWebRtcService {
  private callSession = inject(CallSessionService);
  private voiceService = inject(VoiceService);
  private voiceWs = inject(VoiceWebsocketService);
  private audioSettings = inject(AudioSettingsService);

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

  // MID → { userId, kind, shareId } — used to route ontrack events
  private readonly midMap = new Map<string, { userId: string; kind: 'audio' | 'video' | 'screen'; shareId?: string }>();

  // Audio elements for remote participants — browser won't auto-play WebRTC audio in Tauri/WebView2
  private readonly remoteAudio = new Map<string, HTMLAudioElement>();

  // ── Speaking detection ───────────────────────────────────────────────────
  private audioCtx: AudioContext | null = null;
  private rafHandle: number | null = null;
  private lastSpeaking = false;
  private readonly SPEAKING_THRESHOLD = 0.02;

  // ── Prev-state for change detection inside effects ───────────────────────
  private prevMuted = false;
  private prevCameraOn = false;
  private prevSharing = false;

  // ── Negotiation serialisation ────────────────────────────────────────────
  // RTCPeerConnection only allows one offer/answer exchange at a time. Queuing
  // ensures publishAudioTrack and any concurrent subscribeToTrack calls never
  // race on setLocalDescription / setRemoteDescription.
  private negotiationChain: Promise<unknown> = Promise.resolve();

  // ── RxJS subscriptions to WS observables ────────────────────────────────
  private wsSubs: Subscription[] = [];

  constructor() {
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

  private async connect(callId: string): Promise<void> {
    this.callId = callId; // Set immediately so re-entry is prevented

    // CF Calls SFU has a publicly routable server — no STUN/TURN needed.
    // bundlePolicy: 'max-bundle' is required by Cloudflare Calls.
    this.pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
    (window as any).__pc = this.pc;  // ← add this line
    this.pc.ontrack = (e) => this.handleRemoteTrack(e);

    // TODO(backend): Implement POST /api/v1/messaging/voice/calls/{callId}/session.
    // Steps on the server:
    //   1. POST to CF: https://rtc.live.cloudflare.com/v1/apps/{APP_ID}/sessions/new
    //      with header: Authorization: Bearer {APP_SECRET}  (no request body needed)
    //   2. Store the returned sessionId in your DB as the CF session for this user in this call.
    //   3. Respond to the client with: { cfSessionId: string }
    //   4. Emit 'ParticipantJoined' via SignalR to all OTHER call members with:
    //        { userId, cfSessionId, audioTrackName: 'audio' }
    //      (you'll need to emit this AFTER the client publishes their audio track — see cfTracksNew)
    const { cfSessionId } = await firstValueFrom(this.voiceService.cfCreateSession(callId));
    if (!this.callId) return;
    this.cfSessionId = cfSessionId;

    // Set up WS listeners NOW — cfSessionId is ready and we need to be subscribed before
    // publishAudioTrack triggers ExchangeParticipantJoined on the server, which sends
    // ParticipantJoined back to us for any already-connected participants.
    this.setupWsListeners();

    // Acquire microphone (video is handled separately by CallSessionService.toggleCamera)
    let micStream: MediaStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: this.audioSettings.buildAudioConstraint(),
        video: false,
      });
    } catch {
      console.warn('[WebRTC] Microphone access denied — joining without audio');
      return;
    }
    if (!this.callId) { micStream.getTracks().forEach(t => t.stop()); return; }

    this.audioTrack = micStream.getAudioTracks()[0];
    // Apply current mute state immediately (user may have muted before connecting)
    const isMuted = this.callSession.session()?.local.isMuted ?? false;
    this.audioTrack.enabled = !isMuted;
    this.prevMuted = isMuted;

    await this.publishAudioTrack(this.audioTrack);
    if (!this.callId) return;

    this.startSpeakingDetection(micStream);
  }

  private disconnect(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.audioCtx?.close().catch(() => void 0);
    this.audioTrack?.stop();
    this.pc?.close();
    this.remoteAudio.forEach(a => { a.pause(); a.srcObject = null; });
    this.remoteAudio.clear();
    this.wsSubs.forEach(s => s.unsubscribe());

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
    this.negotiationChain = Promise.resolve();
    this.wsSubs = [];
    this.lastSpeaking = false;
    this.prevMuted = false;
    this.prevCameraOn = false;
    this.prevSharing = false;
  }

  // ── SDP offer/answer cycle ────────────────────────────────────────────────

  // Serialise all SDP exchanges through a promise chain so concurrent publish
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

  // ── Local track publishing ────────────────────────────────────────────────

  private async publishAudioTrack(track: MediaStreamTrack): Promise<void> {
    if (!this.pc) return;
    const transceiver = this.pc.addTransceiver(track, { direction: 'sendonly' });
    await this.offerAnswerCycle(() => [{
      location: 'local',
      mid: transceiver.mid ?? '0',
      trackName: 'audio',
    }]);
  }

  private async publishVideoTrack(stream: MediaStream): Promise<void> {
    if (!this.pc || !this.callId) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const transceiver = this.pc.addTransceiver(track, { direction: 'sendonly' });
    const results = await this.offerAnswerCycle(() => [{
      location: 'local',
      mid: transceiver.mid ?? '0',
      trackName: 'video',
    }]);
    this.videoSender = transceiver.sender;
    this.videoTrackName = results[0]?.trackName ?? 'video';
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

  private async publishScreenTrack(shareId: string, stream: MediaStream): Promise<void> {
    if (!this.pc || !this.callId) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const transceiver = this.pc.addTransceiver(track, { direction: 'sendonly' });
    const cfTrackName = `screen-${shareId}`;
    const results = await this.offerAnswerCycle(() => [{
      location: 'local',
      mid: transceiver.mid ?? '0',
      trackName: cfTrackName,
    }]);
    this.screenSender = transceiver.sender;
    this.screenTrackName = results[0]?.trackName ?? cfTrackName;
    this.screenShareId = shareId;
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

  // ── Remote track subscription ─────────────────────────────────────────────

  private async subscribeToTrack(
    userId: string,
    remoteCfSessionId: string,
    trackName: string,
    kind: 'audio' | 'video' | 'screen',
    shareId?: string,
  ): Promise<void> {
    if (!this.pc) return;
    console.log('[WebRTC] subscribeToTrack', { userId, remoteCfSessionId, trackName, kind });
    const mediaKind = kind === 'audio' ? 'audio' : 'video';
    const transceiver = this.pc.addTransceiver(mediaKind, { direction: 'recvonly' });

    const results = await this.offerAnswerCycle(() => [{
      location: 'remote',
      sessionId: remoteCfSessionId,
      trackName,
    }]);
    console.log('[WebRTC] subscribeToTrack results', results);

    // Map the MID (from CF response or our transceiver) so handleRemoteTrack can route it
    const mid = results.find(r => r.trackName === trackName)?.mid ?? transceiver.mid;
    console.log('[WebRTC] midMap set', mid, '→', { userId, kind });
    if (mid) this.midMap.set(mid, { userId, kind, shareId });
  }

  // ── Remote track routing ──────────────────────────────────────────────────

  private handleRemoteTrack(event: RTCTrackEvent): void {
    const mid = event.transceiver.mid;
    console.log('[WebRTC] ontrack', { mid, kind: event.track.kind, midMapKeys: [...this.midMap.keys()] });
    if (!mid) return;
    const info = this.midMap.get(mid);
    if (!info) return;

    const stream = event.streams[0] ?? new MediaStream([event.track]);

    if (info.kind === 'audio') {
      // WebView2/Tauri does not auto-render WebRTC audio — requires explicit <audio> element.
      const audio = new Audio();
      audio.srcObject = stream;
      audio.autoplay = true;
      audio.play().catch(() => void 0);
      this.remoteAudio.get(info.userId)?.pause();
      this.remoteAudio.set(info.userId, audio);
      event.track.onended = () => {
        this.remoteAudio.get(info.userId)?.pause();
        this.remoteAudio.delete(info.userId);
      };
    } else if (info.kind === 'video') {
      this.callSession.onCameraChanged(info.userId, true, stream);
      event.track.onended = () => this.callSession.onCameraChanged(info.userId, false);
    } else if (info.kind === 'screen' && info.shareId) {
      this.callSession.onScreenShareStarted(info.shareId, info.userId, stream);
      event.track.onended = () => this.callSession.onScreenShareStopped(info.shareId!);
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
