import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ChannelDto, ChannelType } from '../dtos/response/guild.dto';
import { ProfileService } from './profile.service';
import { GuildVoiceService, VoiceParticipantDto } from './guild-voice.service';
import {
  GuildWebsocketService,
  WsGuildParticipantJoined,
  WsGuildTrackClosed,
  WsGuildTrackPublished,
  WsMovedToChannel,
  WsUserJoinedVoice,
  WsUserLeftVoice,
  WsVoiceCameraChanged,
  WsVoiceDeafenChanged,
  WsVoiceMuteChanged,
  WsVoiceScreenShareStarted,
} from './guild-websocket.service';
import { environment } from '../../environments/environment';
import { AudioSettingsService } from './audio-settings.service';
import { SoundSettingsService } from './sound-settings.service';
import { RustMediaService } from './rust-media.service';
import { ScreenPickerService } from './screen-picker.service';
import {authConfig} from "../app.config";

export interface VoiceChannelParticipant {
  userId: string;
  displayName: string;
  avatarLabel: string;
  avatarUrl?: string;
  isMuted: boolean;
  isSpeaking: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  isServerDeafened: boolean;
  isLocal: boolean;
  cfSessionId?: string | null;
}

export interface VoiceLocalState {
  isMuted: boolean;
  isDeafened: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
}

@Injectable({ providedIn: 'root' })
export class VoiceChannelService {
  private profileService  = inject(ProfileService);
  private guildVoiceSvc   = inject(GuildVoiceService);
  private guildWsSvc      = inject(GuildWebsocketService);
  private audioSettings   = inject(AudioSettingsService);
  private soundSettings   = inject(SoundSettingsService);
  private rustMedia       = inject(RustMediaService);
  private screenPicker    = inject(ScreenPickerService);

  // ── Public state ──────────────────────────────────────────────────────────

  private channelParticipantsSignal = signal<Map<string, VoiceChannelParticipant[]>>(new Map());
  readonly channelParticipants = this.channelParticipantsSignal.asReadonly();

  readonly joinedChannelId   = signal<string | null>(null);
  readonly joinedGuildId     = signal<string | null>(null);
  readonly joinedChannelName = signal<string | null>(null);
  readonly joinedGuildName   = signal<string | null>(null);
  readonly localState        = signal<VoiceLocalState>({ isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false });
  readonly isInVoice         = computed(() => this.joinedChannelId() !== null);

  // ── Connection state ──────────────────────────────────────────────────────
  readonly rtcState = signal<RTCPeerConnectionState>('new');
  readonly participantsWithAudio = signal<Set<string>>(new Set());

  // Exposed streams for <video> bindings in the component
  readonly localVideoStream    = signal<MediaStream | null>(null);
  readonly localScreenStream   = signal<MediaStream | null>(null);
  readonly localScreenHasAudio = signal<boolean>(false);
  readonly localScreenAudioMuted = signal<boolean>(false);
  private videoStreamsSignal  = signal<Map<string, MediaStream>>(new Map());
  private screenStreamsSignal = signal<Map<string, MediaStream>>(new Map());
  readonly videoStreams       = this.videoStreamsSignal.asReadonly();
  readonly screenStreams      = this.screenStreamsSignal.asReadonly();

  getVideoStream(userId: string):  MediaStream | null { return this.videoStreamsSignal().get(userId)  ?? null; }
  getScreenStream(userId: string): MediaStream | null { return this.screenStreamsSignal().get(userId) ?? null; }

  // ── WebRTC internals ──────────────────────────────────────────────────────

  private pc: RTCPeerConnection | null = null;
  private cfSessionId: string | null = null;
  private setupDone = false;
  private pendingJoinId: string | null = null;

  private localAudioTrack:      MediaStreamTrack | null = null;
  private localVideoTrack:      MediaStreamTrack | null = null;
  private localScreenTrack:     MediaStreamTrack | null = null;
  private localScreenAudioTrack: MediaStreamTrack | null = null;
  private screenShareId: string | null = null;

  private cfAudioTrackName: string | null = null;
  private cfVideoTrackName: string | null = null;

  // Serialises all SDP offer/answer cycles — concurrent calls to subscribeAudio/subscribeVideo
  // or onnegotiationneeded would race on setLocalDescription otherwise.
  private negotiationChain: Promise<void> = Promise.resolve();

  // Maps a remote transceiver MID → { userId, kind }
  private midMeta = new Map<string, { userId: string; kind: 'audio' | 'video' | 'screen' | 'screenAudio' }>();

  // Audio playback elements keyed by userId — WebView2/Tauri requires explicit <audio> elements
  private remoteAudioEls       = new Map<string, HTMLAudioElement>();
  private remoteScreenAudioEls = new Map<string, HTMLAudioElement>();

  // Per-user volume overrides (0–1.0), persisted across track reconnections
  private readonly userVolumes = new Map<string, number>();

  // Track local senders so bitrate can be changed on the fly
  private readonly localSenders = new Map<string, RTCRtpSender>();

  // Per-participant local screen-audio mute
  private screenAudioMutedSignal = signal<Set<string>>(new Set());
  readonly screenAudioMuted = this.screenAudioMutedSignal.asReadonly();

  isScreenAudioMuted(userId: string): boolean { return this.screenAudioMutedSignal().has(userId); }

  toggleScreenAudioMute(userId: string): void {
    const willMute = !this.screenAudioMutedSignal().has(userId);
    const audio = this.remoteScreenAudioEls.get(userId);
    if (audio) audio.volume = willMute ? 0 : 1;
    this.screenAudioMutedSignal.update(s => {
      const n = new Set(s);
      willMute ? n.add(userId) : n.delete(userId);
      return n;
    });
  }

  toggleLocalScreenAudio(): void {
    if (!this.localScreenAudioTrack) return;
    const muted = !this.localScreenAudioMuted();
    this.localScreenAudioTrack.enabled = !muted;
    this.localScreenAudioMuted.set(muted);
  }

  // VAD interval handles keyed by userId (or 'local')
  private vadHandles = new Map<string, ReturnType<typeof setInterval>>();

  private lastLoadedGuildId: string | null = null;

  constructor() {
    effect(() => {
      const s = this.audioSettings.settings();
      const screenFps = s.screenVideoBitrate >= 8000 ? 30 : 15;
      void this.applyBitrate(this.localSenders.get('audio'),       s.audioBitrate);
      void this.applyBitrate(this.localSenders.get('video'),       s.videoBitrate);
      void this.applyBitrate(this.localSenders.get('screenVideo'), s.screenVideoBitrate, screenFps);
      void this.applyBitrate(this.localSenders.get('screenAudio'), s.screenAudioBitrate);
    });

    this.guildWsSvc.userJoinedVoiceObservable.subscribe(e        => this.onUserJoinedVoice(e));
    this.guildWsSvc.userLeftVoiceObservable.subscribe(e          => this.onUserLeftVoice(e));
    this.guildWsSvc.guildParticipantJoinedObservable.subscribe(e => this.onParticipantJoined(e));
    this.guildWsSvc.guildTrackPublishedObservable.subscribe(e    => this.onTrackPublished(e));
    this.guildWsSvc.guildTrackClosedObservable.subscribe(e       => this.onTrackClosed(e));
    this.guildWsSvc.voiceMuteChangedObservable.subscribe(e       => this.onMuteChanged(e));
    this.guildWsSvc.voiceDeafenChangedObservable.subscribe(e     => this.onDeafenChanged(e));
    this.guildWsSvc.voiceCameraChangedObservable.subscribe(e     => this.onCameraChanged(e));
    this.guildWsSvc.voiceScreenShareStartedObservable.subscribe(e => this.onScreenShareStarted(e));
    this.guildWsSvc.voiceScreenShareStoppedObservable.subscribe(() => { /* TrackClosed handles cleanup */ });
    this.guildWsSvc.movedToChannelObservable.subscribe(e         => void this.onMovedToChannel(e));
  }

  // ── Voice state loading for sidebar display ───────────────────────────────

  loadVoiceStatesForGuild(channels: ChannelDto[], guildId: string): void {
    if (this.lastLoadedGuildId === guildId) return;
    this.lastLoadedGuildId = guildId;

    channels
      .filter(c => c.type === ChannelType.Voice)
      .forEach(channel => {
        if (this.joinedChannelId() === channel.id) return;
        this.guildVoiceSvc.getState(guildId, channel.id).subscribe({
          next: state => {
            const ownId = this.profileService.ownProfile()?.userId ?? '';
            const participants = state.participants.map(p => this.dtoToParticipant(p, ownId));
            this.channelParticipantsSignal.update(map => {
              const next = new Map(map);
              next.set(channel.id, participants);
              return next;
            });
          },
          error: () => {},
        });
      });
  }

  // ── Join / leave ──────────────────────────────────────────────────────────

  async joinChannel(channel: ChannelDto, guildName: string): Promise<void> {
    if (this.pendingJoinId === channel.id || this.joinedChannelId() === channel.id) return;

    const prevId    = this.joinedChannelId();
    const prevGuild = this.joinedGuildId();
    this.pendingJoinId = channel.id;

    try {
      if (prevId && prevGuild) {
        await this.doLeave(prevGuild, prevId, true);
      }

      this.joinedChannelId.set(channel.id);
      this.joinedGuildId.set(channel.guildId);
      this.joinedChannelName.set(channel.name);
      this.joinedGuildName.set(guildName);
      this.localState.set({ isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false });

      try {
        const state   = await firstValueFrom(this.guildVoiceSvc.join(channel.guildId, channel.id));
        const ownId   = this.profileService.ownProfile()?.userId ?? '';
        const list    = state.participants.map(p => this.dtoToParticipant(p, ownId));

        if (!list.find(p => p.isLocal)) {
          const profile = this.profileService.ownProfile();
          list.unshift({
            userId:           ownId,
            displayName:      profile?.userName ?? 'You',
            avatarLabel:      (profile?.userName?.[0] ?? 'Y').toUpperCase(),
            avatarUrl:        profile?.avatarUrl,
            isMuted:          false,
            isSpeaking:       false,
            isCameraOn:       false,
            isScreenSharing:  false,
            isServerDeafened: false,
            isLocal:          true,
          });
        }

        this.channelParticipantsSignal.update(map => { const n = new Map(map); n.set(channel.id, list); return n; });
        this.soundSettings.playVoiceJoin();
        await this.initWebRTC(channel.guildId, channel.id);
      } catch (err) {
        console.error('VoiceChannelService: join failed', err);
      }
    } finally {
      this.pendingJoinId = null;
    }
  }

  async leaveChannel(): Promise<void> {
    const channelId = this.joinedChannelId();
    const guildId   = this.joinedGuildId();
    if (!channelId || !guildId) return;
    await this.doLeave(guildId, channelId, false);
    this.joinedChannelId.set(null);
    this.joinedGuildId.set(null);
    this.joinedChannelName.set(null);
    this.joinedGuildName.set(null);
    this.localState.set({ isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false });
  }

  private async doLeave(guildId: string, channelId: string, silent: boolean): Promise<void> {
    this.soundSettings.playVoiceLeave();
    if (this.cfSessionId) {
      const trackNames: string[] = [];
      if (this.cfAudioTrackName) trackNames.push(this.cfAudioTrackName);
      if (this.cfVideoTrackName) trackNames.push(this.cfVideoTrackName);
      if (this.localScreenTrack && this.screenShareId) {
        trackNames.push(`screen-${this.screenShareId}`);
        if (this.localScreenAudioTrack) trackNames.push(`screen-audio-${this.screenShareId}`);
      }
      if (trackNames.length > 0) {
        await firstValueFrom(this.guildVoiceSvc.closeTracks(guildId, channelId, this.cfSessionId, trackNames)).catch(() => {});
      }
    }
    this.teardownWebRTC();
    if (!silent) {
      await firstValueFrom(this.guildVoiceSvc.leave(guildId, channelId)).catch(() => {});
    }
    this.channelParticipantsSignal.update(map => {
      const n = new Map(map);
      const remaining = (n.get(channelId) ?? []).filter(p => !p.isLocal);
      n.set(channelId, remaining);
      return n;
    });
    this.videoStreamsSignal.set(new Map());
    this.screenStreamsSignal.set(new Map());
    this.localVideoStream.set(null);
    this.localScreenStream.set(null);
    this.localScreenHasAudio.set(false);
    this.localScreenAudioMuted.set(false);
    this.screenAudioMutedSignal.set(new Set());
  }

  // ── WebRTC setup ──────────────────────────────────────────────────────────

  private async initWebRTC(guildId: string, channelId: string): Promise<void> {
    this.setupDone = false;

    // Block the negotiation queue until the initial publish completes so that
    // GuildParticipantJoined WS events (which the server sends as soon as we
    // publish) don't try to subscribe before the base offer/answer is done.
    let releaseQueue!: () => void;
    this.negotiationChain = new Promise<void>(resolve => { releaseQueue = resolve; });

    try {
      this.pc = new RTCPeerConnection({ iceServers: environment.iceServers, bundlePolicy: 'max-bundle' });
      this.pc.ontrack = e => this.handleRemoteTrack(e);
      this.pc.onconnectionstatechange = () => {
        if (this.pc) this.rtcState.set(this.pc.connectionState);
      };

      let audioTrack: MediaStreamTrack;
      try {
        const s = this.audioSettings.settings();
        if (s.enhancedNoiseSuppression) {
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
        this.setupDone = true;
        return;
      }
      const localStream = new MediaStream([audioTrack]);

      this.localAudioTrack = localStream.getAudioTracks()[0];
      this.localAudioTrack.enabled = !this.localState().isMuted;
      this.setupLocalVAD(localStream);

      const sender = this.pc.addTrack(this.localAudioTrack, localStream);
      this.localSenders.set('audio', sender);

      const { cfSessionId } = await firstValueFrom(this.guildVoiceSvc.createSession(guildId, channelId));
      this.cfSessionId = cfSessionId;

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      const audioMid = this.pc.getTransceivers().find(t => t.sender === sender)?.mid ?? '0';

      const publishResp = await firstValueFrom(this.guildVoiceSvc.tracksNew(guildId, channelId, {
        cfSessionId,
        sessionDescription: this.pc.localDescription!,
        tracks: [{ location: 'local', mid: audioMid, trackName: 'audio' }],
      }));

      this.cfAudioTrackName = publishResp.tracks[0]?.trackName ?? 'audio';
      await this.pc.setRemoteDescription(publishResp.sessionDescription);
      if (publishResp.requiresImmediateRenegotiation) await this.renegotiate(guildId, channelId);
      await this.applyBitrate(sender, this.audioSettings.settings().audioBitrate);

      this.setupDone = true;
    } finally {
      releaseQueue();
    }
    // No batch subscription here — the server sends GuildParticipantJoined for
    // each existing participant when we publish, and onParticipantJoined handles it.
  }

  private subscribeAudio(
    guildId: string,
    channelId: string,
    targets: { userId: string; cfSessionId: string; trackName: string; kind?: 'audio' | 'screenAudio' }[],
  ): Promise<void> {
    return this.enqueueNegotiation(async () => {
      if (!this.pc || !this.cfSessionId) return;

      const entries = targets.map(t => ({
        ...t,
        kind: t.kind ?? ('audio' as const),
        transceiver: this.pc!.addTransceiver('audio', { direction: 'recvonly' }),
      }));

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      const resp = await firstValueFrom(this.guildVoiceSvc.tracksNew(guildId, channelId, {
        cfSessionId: this.cfSessionId,
        sessionDescription: this.pc.localDescription!,
        tracks: entries.map(e => ({
          location: 'remote' as const,
          trackName: e.trackName,
          sessionId: e.cfSessionId,
        })),
      }));

      resp.tracks.forEach((t, i) => {
        if (t.mid && entries[i]) {
          this.midMeta.set(t.mid, { userId: entries[i].userId, kind: entries[i].kind });
        }
      });

      await this.pc.setRemoteDescription(resp.sessionDescription);
      if (resp.requiresImmediateRenegotiation) await this.renegotiate(guildId, channelId);
    });
  }

  private subscribeVideo(
    guildId: string,
    channelId: string,
    userId: string,
    cfSessionId: string,
    trackName: string,
    kind: 'video' | 'screen',
  ): Promise<void> {
    return this.enqueueNegotiation(async () => {
      if (!this.pc || !this.cfSessionId) return;

      const transceiver = this.pc.addTransceiver('video', { direction: 'recvonly' });
      // Prefer VP9 on the receive side for the same efficiency gains.
      const caps = RTCRtpReceiver.getCapabilities('video')?.codecs ?? [];
      const ordered = [
        ...caps.filter(c => c.mimeType === 'video/VP9'),
        ...caps.filter(c => c.mimeType === 'video/H264'),
        ...caps.filter(c => c.mimeType !== 'video/VP9' && c.mimeType !== 'video/H264'),
      ];
      if (ordered.length) try { transceiver.setCodecPreferences(ordered); } catch {}
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      const resp = await firstValueFrom(this.guildVoiceSvc.tracksNew(guildId, channelId, {
        cfSessionId: this.cfSessionId,
        sessionDescription: this.pc.localDescription!,
        tracks: [{ location: 'remote', trackName, sessionId: cfSessionId }],
      }));

      if (resp.tracks[0]?.mid) {
        this.midMeta.set(resp.tracks[0].mid, { userId, kind });
      }

      await this.pc.setRemoteDescription(resp.sessionDescription);
      if (resp.requiresImmediateRenegotiation) await this.renegotiate(guildId, channelId);
    });
  }

  private handleRemoteTrack(event: RTCTrackEvent): void {
    const mid = event.transceiver.mid;
    if (!mid) return;
    const meta = this.midMeta.get(mid);
    if (!meta) return;

    const stream = event.streams[0] ?? new MediaStream([event.track]);

    if (meta.kind === 'audio' || meta.kind === 'screenAudio') {
      const elMap = meta.kind === 'screenAudio' ? this.remoteScreenAudioEls : this.remoteAudioEls;

      let audio = elMap.get(meta.userId);
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        elMap.set(meta.userId, audio);
      } else {
        audio.pause();
      }
      audio.srcObject = stream;
      audio.volume = meta.kind === 'audio'
        ? (this.localState().isDeafened ? 0 : (this.userVolumes.get(meta.userId) ?? 1))
        : (this.screenAudioMutedSignal().has(meta.userId) ? 0 : 1);
      const speakerId = this.audioSettings.settings().speakerId;
      if (speakerId && speakerId !== 'default' && typeof (audio as any).setSinkId === 'function') {
        (audio as any).setSinkId(speakerId).catch(() => void 0);
      }
      void audio.play().catch(() => {});

      if (meta.kind === 'audio') {
        this.participantsWithAudio.update(s => { const n = new Set(s); n.add(meta.userId); return n; });
        this.setupRemoteVAD(meta.userId, stream);
      }
    } else if (meta.kind === 'video') {
      this.videoStreamsSignal.update(m => { const n = new Map(m); n.set(meta.userId, stream); return n; });
    } else {
      this.screenStreamsSignal.update(m => { const n = new Map(m); n.set(meta.userId, stream); return n; });
    }
  }

  private enqueueNegotiation(fn: () => Promise<void>): Promise<void> {
    const next = this.negotiationChain.catch(() => {}).then(fn);
    this.negotiationChain = next.catch(() => {});
    return next;
  }

  private async renegotiate(guildId: string, channelId: string): Promise<void> {
    if (!this.pc || !this.cfSessionId) return;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    const resp = await firstValueFrom(this.guildVoiceSvc.renegotiate(guildId, channelId, this.cfSessionId, offer));
    await this.pc.setRemoteDescription(resp.sessionDescription);
  }

  private teardownWebRTC(): void {
    this.vadHandles.forEach(h => clearInterval(h));
    this.vadHandles.clear();

    this.remoteAudioEls.forEach(a => { a.pause(); a.srcObject = null; });
    this.remoteAudioEls.clear();
    this.remoteScreenAudioEls.forEach(a => { a.pause(); a.srcObject = null; });
    this.remoteScreenAudioEls.clear();
    this.localSenders.clear();

    this.localAudioTrack?.stop();
    void this.rustMedia.stopMicCapture();
    this.localVideoTrack?.stop();
    this.localScreenTrack?.stop();
    void this.rustMedia.stopScreenCapture();
    this.localScreenAudioTrack?.stop();
    this.localAudioTrack = null;
    this.localVideoTrack = null;
    this.localScreenTrack = null;
    this.localScreenAudioTrack = null;
    this.screenShareId = null;

    this.pc?.close();
    this.rtcState.set('new');
    this.participantsWithAudio.set(new Set());
    this.userVolumes.clear();
    this.pc = null;
    this.cfSessionId = null;
    this.cfAudioTrackName = null;
    this.cfVideoTrackName = null;
    this.setupDone = false;
    this.midMeta.clear();
    this.negotiationChain = Promise.resolve();
  }

  // ── Local controls ────────────────────────────────────────────────────────

  toggleMute(): void {
    this.localState.update(s => ({ ...s, isMuted: !s.isMuted }));
    if (this.localAudioTrack) this.localAudioTrack.enabled = !this.localState().isMuted;
    const channelId = this.joinedChannelId();
    if (channelId) this.guildWsSvc.invokeVoiceMuteChanged(channelId, this.localState().isMuted);
    this.syncLocal();
  }

  toggleDeafen(): void {
    this.localState.update(s => {
      const d = !s.isDeafened;
      return { ...s, isDeafened: d, isMuted: d || s.isMuted };
    });
    const { isDeafened, isMuted } = this.localState();
    if (this.localAudioTrack) this.localAudioTrack.enabled = !isMuted;
    this.remoteAudioEls.forEach((a, userId) => {
      a.volume = isDeafened ? 0 : (this.userVolumes.get(userId) ?? 1);
    });
    const channelId = this.joinedChannelId();
    if (channelId) {
      this.guildWsSvc.invokeVoiceDeafenChanged(channelId, isDeafened);
      this.guildWsSvc.invokeVoiceMuteChanged(channelId, isMuted);
    }
    this.syncLocal();
  }

  async toggleCamera(): Promise<void> {
    const guildId   = this.joinedGuildId();
    const channelId = this.joinedChannelId();
    if (!guildId || !channelId || !this.pc || !this.cfSessionId) return;

    if (this.localState().isCameraOn && this.localVideoTrack) {
      this.localVideoTrack.stop();
      const sender = this.pc.getSenders().find(s => s.track === this.localVideoTrack);
      if (sender) this.pc.removeTrack(sender);
      await firstValueFrom(this.guildVoiceSvc.closeTracks(guildId, channelId, this.cfSessionId, [this.cfVideoTrackName ?? 'video'])).catch(() => {});
      this.localVideoTrack = null;
      this.localVideoStream.set(null);
      this.localSenders.delete('video');
      this.localState.update(s => ({ ...s, isCameraOn: false }));
      this.guildWsSvc.invokeVoiceCameraChanged(channelId, false);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        this.localVideoTrack = stream.getVideoTracks()[0];
        this.localVideoStream.set(new MediaStream([this.localVideoTrack]));

        await this.enqueueNegotiation(async () => {
          if (!this.pc || !this.cfSessionId) return;
          const sender = this.pc.addTrack(this.localVideoTrack!, stream);
          const offer = await this.pc.createOffer();
          await this.pc.setLocalDescription(offer);
          const mid = this.pc.getTransceivers().find(t => t.sender === sender)?.mid ?? '0';
          const resp = await firstValueFrom(this.guildVoiceSvc.tracksNew(guildId, channelId, {
            cfSessionId: this.cfSessionId!,
            sessionDescription: this.pc.localDescription!,
            tracks: [{ location: 'local', mid, trackName: 'video' }],
          }));
          this.cfVideoTrackName = resp.tracks[0]?.trackName ?? 'video';
          await this.pc.setRemoteDescription(resp.sessionDescription);
          if (resp.requiresImmediateRenegotiation) await this.renegotiate(guildId, channelId);
          await this.applyBitrate(sender, this.audioSettings.settings().videoBitrate);
          this.localSenders.set('video', sender);
        });

        this.localState.update(s => ({ ...s, isCameraOn: true }));
        this.guildWsSvc.invokeVoiceCameraChanged(channelId, true);
      } catch { return; }
    }
    this.syncLocal();
  }

  async toggleScreenShare(): Promise<void> {
    const guildId   = this.joinedGuildId();
    const channelId = this.joinedChannelId();
    if (!guildId || !channelId || !this.pc || !this.cfSessionId) return;

    if (this.localState().isScreenSharing && this.localScreenTrack) {
      const shareId    = this.screenShareId ?? 'share';
      const trackNames = [`screen-${shareId}`];
      if (this.localScreenAudioTrack) trackNames.push(`screen-audio-${shareId}`);

      this.localScreenTrack.stop();
      void this.rustMedia.stopScreenCapture();
      void this.rustMedia.stopLoopbackCapture();
      const videoSender = this.pc.getSenders().find(s => s.track === this.localScreenTrack);
      if (videoSender) this.pc.removeTrack(videoSender);

      if (this.localScreenAudioTrack) {
        this.localScreenAudioTrack.stop();
        const audioSender = this.pc.getSenders().find(s => s.track === this.localScreenAudioTrack);
        if (audioSender) this.pc.removeTrack(audioSender);
        this.localScreenAudioTrack = null;
      }

      await firstValueFrom(this.guildVoiceSvc.closeTracks(guildId, channelId, this.cfSessionId, trackNames)).catch(() => {});
      this.guildWsSvc.invokeVoiceScreenShareStopped(channelId, shareId);
      this.localScreenTrack = null;
      this.screenShareId    = null;
      this.localSenders.delete('screenVideo');
      this.localSenders.delete('screenAudio');
      this.localScreenStream.set(null);
      this.localScreenHasAudio.set(false);
      this.localScreenAudioMuted.set(false);
      this.localState.update(s => ({ ...s, isScreenSharing: false }));
    } else {
      try {
        // Use custom Rust picker to bypass the system screen picker UI
        const sourceId = await this.screenPicker.show();
        if (!sourceId) return; // user cancelled

        const fps = Math.round((this.audioSettings.settings().screenVideoBitrate >= 8000) ? 30 : 15);
        const videoTrack = await this.rustMedia.startScreenCapture(sourceId, fps);
        this.localScreenTrack = videoTrack;
        this.localScreenStream.set(new MediaStream([videoTrack]));

        // Capture system audio via WASAPI loopback
        let audioTrack: MediaStreamTrack | null = null;
        try {
          audioTrack = await this.rustMedia.startLoopbackCapture();
        } catch {
          console.warn('[ScreenShare] Loopback audio unavailable');
        }
        this.localScreenAudioTrack = audioTrack;
        this.localScreenHasAudio.set(audioTrack !== null);
        this.localScreenAudioMuted.set(false);

        const stream = new MediaStream(audioTrack ? [videoTrack, audioTrack] : [videoTrack]);

        const shareId = crypto.randomUUID();
        this.screenShareId = shareId;

        this.localScreenTrack.onended = () => {
          if (this.localState().isScreenSharing) void this.toggleScreenShare();
        };

        await this.enqueueNegotiation(async () => {
          if (!this.pc || !this.cfSessionId) return;
          const videoSender = this.pc.addTrack(this.localScreenTrack!, stream);
          const audioSender = this.localScreenAudioTrack
            ? this.pc.addTrack(this.localScreenAudioTrack, stream)
            : null;

          // Prefer VP9 for screen sharing: better quality-per-bit means higher effective fps
          // at the same bitrate compared to VP8.
          const videoTransceiver = this.pc.getTransceivers().find(t => t.sender === videoSender);
          if (videoTransceiver) {
            const caps = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
            const ordered = [
              ...caps.filter(c => c.mimeType === 'video/VP9'),
              ...caps.filter(c => c.mimeType === 'video/H264'),
              ...caps.filter(c => c.mimeType !== 'video/VP9' && c.mimeType !== 'video/H264'),
            ];
            if (ordered.length) try { videoTransceiver.setCodecPreferences(ordered); } catch {}
          }

          const offer = await this.pc.createOffer();
          await this.pc.setLocalDescription(offer);

          const videoMid = this.pc.getTransceivers().find(t => t.sender === videoSender)?.mid ?? '0';
          const tracks: { location: 'local'; mid: string; trackName: string }[] = [
            { location: 'local', mid: videoMid, trackName: `screen-${shareId}` },
          ];
          if (audioSender) {
            const audioMid = this.pc.getTransceivers().find(t => t.sender === audioSender)?.mid ?? '1';
            tracks.push({ location: 'local', mid: audioMid, trackName: `screen-audio-${shareId}` });
          }

          const resp = await firstValueFrom(this.guildVoiceSvc.tracksNew(guildId, channelId, {
            cfSessionId: this.cfSessionId!,
            sessionDescription: this.pc.localDescription!,
            tracks,
          }));
          await this.pc.setRemoteDescription(resp.sessionDescription);
          if (resp.requiresImmediateRenegotiation) await this.renegotiate(guildId, channelId);
          await this.applyBitrate(videoSender, this.audioSettings.settings().screenVideoBitrate, fps);
          this.localSenders.set('screenVideo', videoSender);
          if (audioSender) {
            await this.applyBitrate(audioSender, this.audioSettings.settings().screenAudioBitrate);
            this.localSenders.set('screenAudio', audioSender);
          }
        });

        this.guildWsSvc.invokeVoiceScreenShareStarted(channelId, shareId, `screen-${shareId}`);
        this.localState.update(s => ({ ...s, isScreenSharing: true }));
      } catch { return; }
    }
    this.syncLocal();
  }

  setServerDeafened(userId: string, isDeafened: boolean): void {
    const channelId = this.joinedChannelId();
    if (!channelId) return;
    this.patchParticipant(channelId, userId, p => ({ ...p, isServerDeafened: isDeafened, isMuted: isDeafened || p.isMuted }));
  }

  setUserVolume(userId: string, volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.userVolumes.set(userId, clamped);
    const audio = this.remoteAudioEls.get(userId);
    if (audio && !this.localState().isDeafened) audio.volume = clamped;
  }

  getUserVolume(userId: string): number {
    return this.userVolumes.get(userId) ?? 1;
  }

  private syncLocal(): void {
    const channelId = this.joinedChannelId();
    if (!channelId) return;
    const ownId = this.profileService.ownProfile()?.userId ?? '';
    const { isMuted, isCameraOn, isScreenSharing } = this.localState();
    this.channelParticipantsSignal.update(map => {
      const n = new Map(map);
      const list = (n.get(channelId) ?? []).map(p =>
        p.userId === ownId ? { ...p, isMuted, isCameraOn, isScreenSharing } : p,
      );
      n.set(channelId, list);
      return n;
    });
  }

  // ── SignalR event handlers ────────────────────────────────────────────────

  private onUserJoinedVoice(e: WsUserJoinedVoice): void {
    const ownId = this.profileService.ownProfile()?.userId ?? '';
    if (e.userId === ownId) return;

    if (e.channelId === this.joinedChannelId()) this.soundSettings.playVoiceJoin();

    const profile = this.profileService.getCachedByUserId(e.userId);
    const participant: VoiceChannelParticipant = {
      userId:          e.userId,
      displayName:     profile?.userName ?? e.userId,
      avatarLabel:     (profile?.userName?.[0] ?? '?').toUpperCase(),
      avatarUrl:       profile?.avatarUrl,
      isMuted:           false,
      isSpeaking:        false,
      isCameraOn:        false,
      isScreenSharing:   false,
      isServerDeafened:  false,
      isLocal:           false,
    };

    this.channelParticipantsSignal.update(map => {
      const n = new Map(map);
      const list = n.get(e.channelId) ?? [];
      if (!list.find(p => p.userId === e.userId)) n.set(e.channelId, [...list, participant]);
      return n;
    });
  }

  private onUserLeftVoice(e: WsUserLeftVoice): void {

    if(e.userId == inject(ProfileService).ownProfile()?.userId) {
      return;
    }
    if (e.channelId === this.joinedChannelId()) this.soundSettings.playVoiceLeave();

    this.channelParticipantsSignal.update(map => {
      const n = new Map(map);
      const list = n.get(e.channelId) ?? [];
      n.set(e.channelId, list.filter(p => p.userId !== e.userId));
      return n;
    });

    this.participantsWithAudio.update(s => { const n = new Set(s); n.delete(e.userId); return n; });
    const audio = this.remoteAudioEls.get(e.userId);
    if (audio) { audio.pause(); audio.srcObject = null; this.remoteAudioEls.delete(e.userId); }
    const screenAudio = this.remoteScreenAudioEls.get(e.userId);
    if (screenAudio) { screenAudio.pause(); screenAudio.srcObject = null; this.remoteScreenAudioEls.delete(e.userId); }
    const vad = this.vadHandles.get(e.userId);
    if (vad) { clearInterval(vad); this.vadHandles.delete(e.userId); }
    this.videoStreamsSignal.update(m  => { const n = new Map(m);  n.delete(e.userId); return n; });
    this.screenStreamsSignal.update(m => { const n = new Map(m);  n.delete(e.userId); return n; });
    this.screenAudioMutedSignal.update(s => { const n = new Set(s); n.delete(e.userId); return n; });
  }

  private onParticipantJoined(e: WsGuildParticipantJoined): void {
    if (e.channelId !== this.joinedChannelId()) return;
    this.patchParticipant(e.channelId, e.userId, p => ({ ...p, cfSessionId: e.cfSessionId }));

    const guildId = this.joinedGuildId();
    if (guildId) {
      void this.subscribeAudio(guildId, e.channelId, [{
        userId: e.userId, cfSessionId: e.cfSessionId, trackName: e.audioTrackName,
      }]);
    }
  }

  private onTrackPublished(e: WsGuildTrackPublished): void {
    if (e.channelId !== this.joinedChannelId()) return;
    const guildId = this.joinedGuildId();
    if (!guildId) return;
    if (e.kind === 'screenAudio') {
      void this.subscribeAudio(guildId, e.channelId, [{
        userId: e.userId, cfSessionId: e.cfSessionId, trackName: e.trackName, kind: 'screenAudio',
      }]);
    } else {
      void this.subscribeVideo(guildId, e.channelId, e.userId, e.cfSessionId, e.trackName, e.kind === 'screen' ? 'screen' : 'video');
    }
  }

  private onTrackClosed(e: WsGuildTrackClosed): void {
    if (e.channelId !== this.joinedChannelId()) return;
    if (e.trackName === 'video') {
      this.patchParticipant(e.channelId, e.userId, p => ({ ...p, isCameraOn: false }));
      this.videoStreamsSignal.update(m => { const n = new Map(m); n.delete(e.userId); return n; });
    } else if (e.trackName.startsWith('screen-audio-')) {
      const audio = this.remoteScreenAudioEls.get(e.userId);
      if (audio) { audio.pause(); audio.srcObject = null; this.remoteScreenAudioEls.delete(e.userId); }
    } else if (e.trackName.startsWith('screen-')) {
      this.patchParticipant(e.channelId, e.userId, p => ({ ...p, isScreenSharing: false }));
      this.screenStreamsSignal.update(m => { const n = new Map(m); n.delete(e.userId); return n; });
    }
  }

  private onMuteChanged(e: WsVoiceMuteChanged): void {
    this.patchParticipant(e.channelId, e.userId, p => ({ ...p, isMuted: e.isMuted }));
  }

  private onDeafenChanged(e: WsVoiceDeafenChanged): void {
    if (e.isDeafened) this.patchParticipant(e.channelId, e.userId, p => ({ ...p, isMuted: true }));
  }

  private onCameraChanged(e: WsVoiceCameraChanged): void {
    this.patchParticipant(e.channelId, e.userId, p => ({ ...p, isCameraOn: e.isCameraOn }));
  }

  private onScreenShareStarted(e: WsVoiceScreenShareStarted): void {
    this.patchParticipant(e.channelId, e.userId, p => ({ ...p, isScreenSharing: true }));
  }

  private async onMovedToChannel(e: WsMovedToChannel): Promise<void> {
    const pseudo: ChannelDto = {
      id: e.channelId, guildId: e.guildId, name: 'Voice Channel',
      type: ChannelType.Voice, createdAt: new Date(), updatedAt: new Date(),
      description: '', isAgeRestricted: false, isPrivate: false,
      categoryId: undefined, permissions: [], position: 0,
    };
    await this.joinChannel(pseudo, this.joinedGuildName() ?? '');
  }

  // ── VAD ───────────────────────────────────────────────────────────────────

  private setupLocalVAD(stream: MediaStream): void {
    const ownId = this.profileService.ownProfile()?.userId ?? 'local';
    this.setupVAD('local', ownId, stream);
  }

  private setupRemoteVAD(userId: string, stream: MediaStream): void {
    this.setupVAD(userId, userId, stream);
  }

  private setupVAD(handle: string, userId: string, stream: MediaStream): void {
    try {
      const ctx      = new AudioContext();
      const source   = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const id = setInterval(() => {
        analyser.getByteFrequencyData(data);
        const avg      = data.reduce((a, b) => a + b, 0) / data.length;
        const speaking = avg > 20;
        const channelId = this.joinedChannelId();
        if (channelId) {
          this.patchParticipant(channelId, userId, p => p.isSpeaking === speaking ? p : { ...p, isSpeaking: speaking });
        }
      }, 100);

      const prev = this.vadHandles.get(handle);
      if (prev) clearInterval(prev);
      this.vadHandles.set(handle, id);
    } catch { /* AudioContext unavailable */ }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async applyBitrate(sender: RTCRtpSender | undefined, kbps: number, maxFps?: number): Promise<void> {
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = kbps * 1000;
      if (maxFps !== undefined) params.encodings[0].maxFramerate = maxFps;
      await sender.setParameters(params);
    } catch { /* setParameters not supported or call already ended */ }
  }

  private patchParticipant(
    channelId: string,
    userId: string,
    fn: (p: VoiceChannelParticipant) => VoiceChannelParticipant,
  ): void {
    this.channelParticipantsSignal.update(map => {
      const n = new Map(map);
      const list = n.get(channelId);
      if (list) n.set(channelId, list.map(p => p.userId === userId ? fn(p) : p));
      return n;
    });
  }

  private dtoToParticipant(dto: VoiceParticipantDto, ownId: string): VoiceChannelParticipant {
    const profile = this.profileService.getCachedByUserId(dto.userId);
    return {
      userId:          dto.userId,
      displayName:     profile?.userName ?? dto.userId,
      avatarLabel:     (profile?.userName?.[0] ?? '?').toUpperCase(),
      avatarUrl:       profile?.avatarUrl,
      isMuted:           dto.isSelfMuted || dto.isServerMuted,
      isSpeaking:        false,
      isCameraOn:        false,
      isScreenSharing:   dto.isStreaming,
      isServerDeafened:  dto.isServerDeafened,
      isLocal:           dto.userId === ownId,
      cfSessionId:       dto.cfSessionId,
    };
  }
}
