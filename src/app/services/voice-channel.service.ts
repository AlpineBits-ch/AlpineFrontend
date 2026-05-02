import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { ChannelDto, ChannelType } from '../dtos/response/guild.dto';
import { ProfileService } from './profile.service';

export interface VoiceChannelParticipant {
  userId: string;
  displayName: string;
  avatarLabel: string;
  avatarUrl?: string;
  isMuted: boolean;
  isSpeaking: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  isLocal: boolean;
}

export interface VoiceLocalState {
  isMuted: boolean;
  isDeafened: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
}

const MOCK_SEEDS: VoiceChannelParticipant[] = [
  { userId: 'mock-alice', displayName: 'Alice',  avatarLabel: 'A', isMuted: false, isSpeaking: true,  isCameraOn: false, isScreenSharing: false, isLocal: false },
  { userId: 'mock-bob',   displayName: 'Bob',    avatarLabel: 'B', isMuted: true,  isSpeaking: false, isCameraOn: false, isScreenSharing: false, isLocal: false },
  { userId: 'mock-carol', displayName: 'Carol',  avatarLabel: 'C', isMuted: false, isSpeaking: false, isCameraOn: true,  isScreenSharing: true,  isLocal: false },
  { userId: 'mock-dave',  displayName: 'Dave',   avatarLabel: 'D', isMuted: true,  isSpeaking: false, isCameraOn: false, isScreenSharing: false, isLocal: false },
];

@Injectable({ providedIn: 'root' })
export class VoiceChannelService {
  private profileService = inject(ProfileService);

  private channelParticipantsSignal = signal<Map<string, VoiceChannelParticipant[]>>(new Map());
  readonly channelParticipants = this.channelParticipantsSignal.asReadonly();

  readonly joinedChannelId   = signal<string | null>(null);
  readonly joinedChannelName = signal<string | null>(null);
  readonly joinedGuildName   = signal<string | null>(null);

  readonly localState = signal<VoiceLocalState>({
    isMuted: false,
    isDeafened: false,
    isCameraOn: false,
    isScreenSharing: false,
  });

  readonly isInVoice = computed(() => this.joinedChannelId() !== null);

  // ── Mock data seeding ────────────────────────────────────────────────────

  /**
   * Seeds mock participants into voice channels for visual demo.
   * Safe to call multiple times — skips already-seeded channels.
   */
  seedMockParticipants(channels: ChannelDto[]): void {
    const voiceChannels = channels.filter(c => c.type === ChannelType.Voice);
    this.channelParticipantsSignal.update(map => {
      const next = new Map(map);
      voiceChannels.forEach((channel, index) => {
        if (next.has(channel.id)) return;
        const count = index % 3; // 0, 1, or 2 per channel — deterministic
        if (count > 0) {
          next.set(channel.id, MOCK_SEEDS.slice(0, count));
        }
      });
      return next;
    });
  }

  // ── Join / leave ─────────────────────────────────────────────────────────

  joinChannel(channel: ChannelDto, guildName: string): void {
    const prevId = this.joinedChannelId();

    if (prevId === channel.id) return; // already here

    if (prevId) this.removeLocalFromChannel(prevId);

    const profile = this.profileService.ownProfile();
    const localParticipant: VoiceChannelParticipant = {
      userId:          profile?.userId ?? 'local-user',
      displayName:     profile?.userName ?? 'You',
      avatarLabel:     (profile?.userName?.[0] ?? 'Y').toUpperCase(),
      avatarUrl:       profile?.avatarUrl,
      isMuted:         this.localState().isMuted,
      isSpeaking:      false,
      isCameraOn:      this.localState().isCameraOn,
      isScreenSharing: false,
      isLocal:         true,
    };

    this.channelParticipantsSignal.update(map => {
      const next    = new Map(map);
      const existing = next.get(channel.id) ?? [];
      next.set(channel.id, [localParticipant, ...existing]);
      return next;
    });

    this.joinedChannelId.set(channel.id);
    this.joinedChannelName.set(channel.name);
    this.joinedGuildName.set(guildName);
    this.localState.set({ isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false });

    // TODO(backend): send JoinVoiceChannel RPC to SignalR hub with channel.id
  }

  leaveChannel(): void {
    const channelId = this.joinedChannelId();
    if (!channelId) return;
    this.removeLocalFromChannel(channelId);
    this.joinedChannelId.set(null);
    this.joinedChannelName.set(null);
    this.joinedGuildName.set(null);
    this.localState.set({ isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false });

    // TODO(backend): send LeaveVoiceChannel RPC to SignalR hub
  }

  private removeLocalFromChannel(channelId: string): void {
    const ownId = this.profileService.ownProfile()?.userId ?? 'local-user';
    this.channelParticipantsSignal.update(map => {
      const next     = new Map(map);
      const existing = next.get(channelId) ?? [];
      next.set(channelId, existing.filter(p => p.userId !== ownId));
      return next;
    });
  }

  // ── Local controls ───────────────────────────────────────────────────────

  toggleMute(): void {
    this.localState.update(s => ({ ...s, isMuted: !s.isMuted }));
    this.syncLocalParticipant();
    // TODO(backend): send MuteChanged event via VoiceWebsocketService
  }

  toggleDeafen(): void {
    this.localState.update(s => {
      const isDeafened = !s.isDeafened;
      return { ...s, isDeafened, isMuted: isDeafened ? true : s.isMuted };
    });
    this.syncLocalParticipant();
    // TODO(backend): send DeafenChanged event via VoiceWebsocketService
  }

  async toggleCamera(): Promise<void> {
    const current = this.localState();
    if (current.isCameraOn) {
      this.localState.update(s => ({ ...s, isCameraOn: false }));
    } else {
      try {
        await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        this.localState.update(s => ({ ...s, isCameraOn: true }));
      } catch {
        return;
      }
    }
    this.syncLocalParticipant();
    // TODO(backend): send CameraChanged event via VoiceWebsocketService
  }

  async toggleScreenShare(): Promise<void> {
    const current = this.localState();
    if (current.isScreenSharing) {
      this.localState.update(s => ({ ...s, isScreenSharing: false }));
    } else {
      try {
        await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        this.localState.update(s => ({ ...s, isScreenSharing: true }));
      } catch {
        return;
      }
    }
    this.syncLocalParticipant();
    // TODO(backend): send ScreenShareStarted/Stopped event via VoiceWebsocketService
  }

  private syncLocalParticipant(): void {
    const channelId = this.joinedChannelId();
    if (!channelId) return;
    const ownId = this.profileService.ownProfile()?.userId ?? 'local-user';
    const local = this.localState();
    this.channelParticipantsSignal.update(map => {
      const next = new Map(map);
      const list = (next.get(channelId) ?? []).map(p =>
        p.userId === ownId
          ? { ...p, isMuted: local.isMuted, isCameraOn: local.isCameraOn, isScreenSharing: local.isScreenSharing }
          : p,
      );
      next.set(channelId, list);
      return next;
    });
  }
}
