import { Component, computed, effect, HostListener, inject, input, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { ChannelDto } from '../../../../dtos/response/guild.dto';
import { VoiceChannelParticipant, VoiceChannelService } from '../../../../services/voice-channel.service';
import { NavigationService } from '../../../main-page/navigation.service';
import { AppAvatarComponent } from '../../../../components/avatar/avatar.component';
import { StreamSrcDirective } from '../../../../directives/stream-src.directive';
import { RustMediaService } from '../../../../services/rust-media.service';
import { GuildService } from '../../../../services/guild.service';
import { GuildVoiceService } from '../../../../services/guild-voice.service';
import { ProfileService } from '../../../../services/profile.service';
import { GuildMemberDto } from '../../../../dtos/response/member.dto';
import { hasPermission, parsePermissions, Permissions } from '../../../../enums/permissions.enum';

interface ParticipantMenu {
  x: number;
  y: number;
  participant: VoiceChannelParticipant;
  volume: number; // 0–100
}

@Component({
  selector: 'app-voice-channel',
  imports: [NgClass, AppAvatarComponent, StreamSrcDirective],
  templateUrl: './voice-channel.component.html',
})
export class VoiceChannelComponent {
  channel = input.required<ChannelDto>();

  protected voiceSvc    = inject(VoiceChannelService);
  protected navService  = inject(NavigationService);
  protected rustMedia   = inject(RustMediaService);
  private   guildSvc    = inject(GuildService);
  private   guildVoice  = inject(GuildVoiceService);
  private   profileSvc  = inject(ProfileService);

  readonly fpsList = [5, 10, 15, 30] as const;

  // ── Permission check ────────────────────────────────────────────────────
  private ownMember = signal<GuildMemberDto | null>(null);

  protected isSuperadmin = computed(() => {
    const m = this.ownMember();
    if (!m) return false;
    return hasPermission(parsePermissions(m.permissions), Permissions.Superadmin);
  });

  constructor() {
    effect(() => {
      const guildId = this.channel().guildId;
      this.guildSvc.getOwnMember(guildId).subscribe({ next: m => this.ownMember.set(m), error: () => {} });
    });
  }

  // ── Computed helpers ─────────────────────────────────────────────────────

  protected participants = computed(() =>
    this.voiceSvc.channelParticipants().get(this.channel().id) ?? [],
  );

  protected screenSharers = computed(() =>
    this.participants().filter(p => p.isScreenSharing),
  );

  protected isJoined = computed(() =>
    this.voiceSvc.joinedChannelId() === this.channel().id,
  );

  protected participantGridClass = computed(() => {
    const n = this.participants().length;
    if (n === 1) return 'grid-cols-1 max-w-[200px] mx-auto';
    if (n <= 4)  return 'grid-cols-2 max-w-sm mx-auto';
    if (n <= 9)  return 'grid-cols-3';
    return 'grid-cols-4';
  });

  // ── Context menu ─────────────────────────────────────────────────────────

  protected participantMenu = signal<ParticipantMenu | null>(null);

  protected onParticipantContextMenu(event: MouseEvent, p: VoiceChannelParticipant): void {
    if (p.isLocal) return;
    event.preventDefault();
    event.stopPropagation();
    const volume = Math.round(this.voiceSvc.getUserVolume(p.userId) * 100);
    this.participantMenu.set({ x: event.clientX, y: event.clientY, participant: p, volume });
  }

  protected onVolumeInput(event: Event): void {
    const value = parseInt((event.target as HTMLInputElement).value, 10);
    const menu = this.participantMenu();
    if (!menu) return;
    this.participantMenu.set({ ...menu, volume: value });
    this.voiceSvc.setUserVolume(menu.participant.userId, value / 100);
  }

  protected async kickParticipant(): Promise<void> {
    const menu = this.participantMenu();
    if (!menu) return;
    this.participantMenu.set(null);
    await firstValueFrom(
      this.guildSvc.kickMemberByUserId(this.channel().guildId, menu.participant.userId)
    ).catch(() => {});
  }

  protected async banParticipant(): Promise<void> {
    const menu = this.participantMenu();
    if (!menu) return;
    this.participantMenu.set(null);
    await firstValueFrom(
      this.guildSvc.banMemberByUserId(this.channel().guildId, menu.participant.userId)
    ).catch(() => {});
  }

  protected async toggleServerDeafen(): Promise<void> {
    const menu = this.participantMenu();
    if (!menu) return;
    const { userId, isServerDeafened } = menu.participant;
    const newState = !isServerDeafened;
    this.participantMenu.set({ ...menu, participant: { ...menu.participant, isServerDeafened: newState } });
    this.voiceSvc.setServerDeafened(userId, newState);
    await firstValueFrom(
      this.guildVoice.serverDeafen(this.channel().guildId, this.channel().id, userId, newState)
    ).catch(() => {
      // Rollback on failure
      this.voiceSvc.setServerDeafened(userId, isServerDeafened);
    });
  }

  @HostListener('document:click')
  protected closeMenu(): void { this.participantMenu.set(null); }

  @HostListener('document:keydown.escape')
  protected closeMenuKey(): void { this.participantMenu.set(null); }

  // ── Channel actions ───────────────────────────────────────────────────────

  protected joinChannel(): void {
    const view = this.navService.workspace();
    const guildName = view.type === 'server' ? view.guild.name : '';
    void this.voiceSvc.joinChannel(this.channel(), guildName);
  }

  protected leaveChannel(): void {
    void this.voiceSvc.leaveChannel();
  }

  protected toggleMute():        void { this.voiceSvc.toggleMute(); }
  protected toggleDeafen():      void { this.voiceSvc.toggleDeafen(); }
  protected toggleCamera():      void { void this.voiceSvc.toggleCamera(); }
  protected toggleScreenShare(): void { void this.voiceSvc.toggleScreenShare(); }
  protected setCaptureFps(fps: number): void { void this.rustMedia.setCaptureFps(fps); }

  protected videoStreamFor(userId: string):  MediaStream | null { return this.voiceSvc.getVideoStream(userId); }
  protected screenStreamFor(userId: string): MediaStream | null { return this.voiceSvc.getScreenStream(userId); }

  protected isScreenAudioMuted(userId: string): boolean { return this.voiceSvc.isScreenAudioMuted(userId); }
  protected toggleScreenAudioMute(userId: string): void  { this.voiceSvc.toggleScreenAudioMute(userId); }
  protected toggleLocalScreenAudio(): void { this.voiceSvc.toggleLocalScreenAudio(); }
}
