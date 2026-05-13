import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { ChannelDto } from '../../../../dtos/response/guild.dto';
import { VoiceChannelParticipant, VoiceChannelService } from '../../../../services/voice-channel.service';
import { NavigationService } from '../../../main-page/navigation.service';
import { GuildService } from '../../../../services/guild.service';
import { GuildVoiceService } from '../../../../services/guild-voice.service';
import { GuildMemberDto } from '../../../../dtos/response/member.dto';
import { hasPermission, parsePermissions, Permissions } from '../../../../enums/permissions.enum';
import { RustMediaService } from '../../../../services/rust-media.service';
import { VoiceChannelContextMenuComponent, ParticipantMenuData } from './voice-channel-context-menu.component';
import { VoiceChannelParticipantTileComponent } from './voice-channel-participant-tile.component';
import { VoiceChannelLobbyComponent } from './voice-channel-lobby.component';
import { VoiceChannelControlsBarComponent } from './voice-channel-controls-bar.component';
import { VoiceChannelScreenLayoutComponent } from './voice-channel-screen-layout.component';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-voice-channel',
  imports: [
    NgClass,
    VoiceChannelContextMenuComponent,
    VoiceChannelParticipantTileComponent,
    VoiceChannelLobbyComponent,
    VoiceChannelControlsBarComponent,
    VoiceChannelScreenLayoutComponent,
    TranslateModule,
  ],
  templateUrl: './voice-channel.component.html',
})
export class VoiceChannelComponent {
  channel = input.required<ChannelDto>();

  protected voiceSvc   = inject(VoiceChannelService);
  protected navService = inject(NavigationService);
  protected rustMedia  = inject(RustMediaService);
  private   guildSvc   = inject(GuildService);
  private   guildVoice = inject(GuildVoiceService);

  // ── Permission check ───────────────────────────────────────────────────────

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

  // ── Computed helpers ───────────────────────────────────────────────────────

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

  // ── Context menu ───────────────────────────────────────────────────────────

  protected participantMenu = signal<ParticipantMenuData | null>(null);

  protected onParticipantContextMenu(event: MouseEvent, p: VoiceChannelParticipant): void {
    if (p.isLocal) return;
    event.preventDefault();
    event.stopPropagation();
    const volume = Math.round(this.voiceSvc.getUserVolume(p.userId) * 100);
    const x = Math.min(event.clientX, window.innerWidth  - 236);
    const y = Math.min(event.clientY, window.innerHeight - 200);
    this.participantMenu.set({ x: Math.max(0, x), y: Math.max(0, y), participant: p, volume });
  }

  protected onVolumeChange(value: number): void {
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
      this.voiceSvc.setServerDeafened(userId, isServerDeafened);
    });
  }

  // ── Channel actions ────────────────────────────────────────────────────────

  protected joinChannel(): void {
    const view = this.navService.workspace();
    const guildName = view.type === 'server' ? view.guild.name : '';
    void this.voiceSvc.joinChannel(this.channel(), guildName);
  }

  protected leaveChannel():       void { void this.voiceSvc.leaveChannel(); }
  protected toggleMute():         void { this.voiceSvc.toggleMute(); }
  protected toggleDeafen():       void { this.voiceSvc.toggleDeafen(); }
  protected toggleCamera():       void { void this.voiceSvc.toggleCamera(); }
  protected toggleScreenShare():  void { void this.voiceSvc.toggleScreenShare(); }
  protected setCaptureFps(fps: number): void { void this.rustMedia.setCaptureFps(fps); }
}
