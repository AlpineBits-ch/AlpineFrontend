import { inject, Injectable, signal } from '@angular/core';
import { ProfileService } from './profile.service';
import { ConversationStore } from '../stores/conversation.store';
import { VoiceService } from './voice.service';
import { AudioSettingsService } from './audio-settings.service';
import { RustMediaService } from './rust-media.service';
import { ScreenPickerService } from './screen-picker.service';
import type { CallDto } from '../dtos/response/call.dto';
import type {
  ActiveCallSession,
  CallParticipantUi,
  ScreenShareUi,
} from './call-session.types';

@Injectable({ providedIn: 'root' })
export class CallSessionService {
  private profileService    = inject(ProfileService);
  private conversationStore = inject(ConversationStore);
  private voiceService      = inject(VoiceService);
  private audioSettings     = inject(AudioSettingsService);
  private rustMedia         = inject(RustMediaService);
  private screenPicker      = inject(ScreenPickerService);

  readonly session = signal<ActiveCallSession | null>(null);

  // ── Lifecycle ────────────────────────────────────────────────────────────

  join(callDto: CallDto, conversationId: string): void {
    const ownId = this.profileService.ownProfile()?.userId;
    const conv = this.conversationStore.entities().find(c => c.id === conversationId);

    const participants: CallParticipantUi[] = callDto.participants.map(p => {
      const member = conv?.members.find(m => m.userId === p.userId);
      const profile = this.profileService.getCachedByUserId(p.userId);
      return {
        userId: p.userId,
        displayName: member?.cachedUserName ?? profile?.userName ?? 'Unknown',
        avatarLabel: (member?.cachedUserName?.[0] ?? '?').toUpperCase(),
        avatarUrl: profile?.avatarUrl,
        isLocal: p.userId === ownId,
        isMuted: false,
        isSpeaking: false,
        isCameraOn: false,
        videoStream: undefined,
      };
    });

    this.session.set({
      callId: callDto.id,
      conversationId,
      participants,
      screenShares: [],
      local: { isMuted: false, isDeafened: false, isCameraOn: false, isSharing: false },
      startedAt: new Date(),
    });

    // TODO(webrtc): inject CallWebRtcService and call .connect(callDto, conversationId)
  }

  end(): void {
    const s = this.session();
    if (!s) return;
    // Stop any active local media streams before tearing down
    s.participants.find(p => p.isLocal)?.videoStream?.getTracks().forEach(t => t.stop());
    s.screenShares.find(sh => sh.isLocal)?.stream?.getTracks().forEach(t => t.stop());
    // TODO(webrtc): disconnect all peer connections
    this.voiceService.endCall(s.callId).subscribe();
    this.session.set(null);
  }

  // ── Local controls ───────────────────────────────────────────────────────

  toggleMute(): void {
    this.session.update(s => {
      if (!s) return s;
      return { ...s, local: { ...s.local, isMuted: !s.local.isMuted } };
    });
    // TODO(webrtc): mute/unmute local audio track
  }

  toggleDeafen(): void {
    this.session.update(s => {
      if (!s) return s;
      const isDeafened = !s.local.isDeafened;
      return { ...s, local: { ...s.local, isDeafened, isMuted: isDeafened ? true : s.local.isMuted } };
    });
    // TODO(webrtc): pause/resume all remote audio tracks
  }

  async toggleCamera(): Promise<void> {
    const s = this.session();
    if (!s) return;

    const localP = s.participants.find(p => p.isLocal);

    if (s.local.isCameraOn) {
      localP?.videoStream?.getTracks().forEach(t => t.stop());
      this.session.update(st => st ? {
        ...st,
        participants: st.participants.map(p =>
          p.isLocal ? { ...p, isCameraOn: false, videoStream: undefined } : p
        ),
        local: { ...st.local, isCameraOn: false },
      } : st);
      // TODO(webrtc): remove video track from peer connections
    } else {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch {
        return; // User denied or device unavailable
      }
      this.session.update(st => st ? {
        ...st,
        participants: st.participants.map(p =>
          p.isLocal ? { ...p, isCameraOn: true, videoStream: stream } : p
        ),
        local: { ...st.local, isCameraOn: true },
      } : st);
      // TODO(webrtc): add video track to peer connections
    }
  }

  async toggleScreenShare(): Promise<void> {
    const s = this.session();
    if (!s) return;

    if (s.local.isSharing) {
      const localShare = s.screenShares.find(sh => sh.isLocal);
      localShare?.stream?.getTracks().forEach(t => t.stop());
      void this.rustMedia.stopScreenCapture();
      this.session.update(st => st ? {
        ...st,
        screenShares: st.screenShares.filter(sh => !sh.isLocal),
        local: { ...st.local, isSharing: false },
      } : st);
      // TODO(webrtc): remove screen share track from peer connections
    } else {
      // Show custom Rust-based screen picker instead of the system picker
      const sourceId = await this.screenPicker.show();
      if (!sourceId) return;

      const fps = Math.round(
        (this.audioSettings.settings().screenVideoBitrate >= 8000) ? 30 : 15,
      );
      let videoTrack: MediaStreamTrack;
      try {
        videoTrack = await this.rustMedia.startScreenCapture(sourceId, fps);
      } catch {
        return;
      }

      const stream = new MediaStream([videoTrack]);
      const shareId = crypto.randomUUID();
      const ownId = this.profileService.ownProfile()?.userId ?? '';

      videoTrack.onended = () => {
        this.session.update(st => st ? {
          ...st,
          screenShares: st.screenShares.filter(sh => sh.shareId !== shareId),
          local: { ...st.local, isSharing: false },
        } : st);
      };

      this.session.update(st => st ? {
        ...st,
        screenShares: [...st.screenShares, { shareId, userId: ownId, displayName: 'You', isLocal: true, stream }],
        local: { ...st.local, isSharing: true },
      } : st);
      // TODO(webrtc): add display media track to peer connections
    }
  }

  joinScreenShare(_shareId: string): void {
    // TODO(webrtc): subscribe to the remote MediaStream identified by shareId
  }

  // ── Remote participant events — called by WebRTC service ─────────────────

  onParticipantJoined(userId: string): void {
    const s = this.session();
    if (!s || s.participants.some(p => p.userId === userId)) return;

    const conv = this.conversationStore.entities().find(c => c.id === s.conversationId);
    const member = conv?.members.find(m => m.userId === userId);
    const profile = this.profileService.getCachedByUserId(userId);
    const ownId = this.profileService.ownProfile()?.userId;

    const participant: CallParticipantUi = {
      userId,
      displayName: member?.cachedUserName ?? profile?.userName ?? 'Unknown',
      avatarLabel: (member?.cachedUserName?.[0] ?? '?').toUpperCase(),
      avatarUrl: profile?.avatarUrl,
      isLocal: userId === ownId,
      isMuted: false,
      isSpeaking: false,
      isCameraOn: false,
      videoStream: undefined,
    };

    this.session.update(st => st ? { ...st, participants: [...st.participants, participant] } : st);
  }

  onParticipantLeft(userId: string): void {
    this.session.update(s =>
      s ? { ...s, participants: s.participants.filter(p => p.userId !== userId) } : s
    );
  }

  onSpeakingChanged(userId: string, isSpeaking: boolean): void {
    this.session.update(s => s ? {
      ...s,
      participants: s.participants.map(p => p.userId === userId ? { ...p, isSpeaking } : p),
    } : s);
  }

  onMuteChanged(userId: string, isMuted: boolean): void {
    this.session.update(s => s ? {
      ...s,
      participants: s.participants.map(p => p.userId === userId ? { ...p, isMuted } : p),
    } : s);
  }

  // WebRTC will call this with the remote video stream once peer connection is established
  onCameraChanged(userId: string, isCameraOn: boolean, videoStream?: MediaStream): void {
    this.session.update(s => s ? {
      ...s,
      participants: s.participants.map(p =>
        p.userId === userId ? { ...p, isCameraOn, videoStream: videoStream ?? p.videoStream } : p
      ),
    } : s);
  }

  // WebRTC will call this with the remote screen share stream
  onScreenShareStarted(shareId: string, userId: string, stream?: MediaStream): void {
    const s = this.session();
    const conv = this.conversationStore.entities().find(c => c.id === s?.conversationId);
    const displayName = conv?.members.find(m => m.userId === userId)?.cachedUserName ?? 'Unknown';
    this.session.update(st => {
      if (!st) return st;
      const idx = st.screenShares.findIndex(sh => sh.shareId === shareId);
      if (idx !== -1) {
        if (!stream) return st;
        const updated = [...st.screenShares];
        updated[idx] = { ...updated[idx], stream };
        return { ...st, screenShares: updated };
      }
      const share: ScreenShareUi = { shareId, userId, displayName, isLocal: false, stream };
      return { ...st, screenShares: [...st.screenShares, share] };
    });
  }

  onScreenShareStopped(shareId: string): void {
    this.session.update(s =>
      s ? { ...s, screenShares: s.screenShares.filter(sh => sh.shareId !== shareId) } : s
    );
  }
}
