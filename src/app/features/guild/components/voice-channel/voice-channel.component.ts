import { Component, computed, inject, input } from '@angular/core';
import { NgClass } from '@angular/common';
import { ChannelDto } from '../../../../dtos/response/guild.dto';
import { VoiceChannelParticipant, VoiceChannelService } from '../../../../services/voice-channel.service';
import { NavigationService } from '../../../main-page/navigation.service';
import { AppAvatarComponent } from '../../../../components/avatar/avatar.component';

@Component({
  selector: 'app-voice-channel',
  imports: [NgClass, AppAvatarComponent],
  templateUrl: './voice-channel.component.html',
})
export class VoiceChannelComponent {
  channel = input.required<ChannelDto>();

  protected voiceSvc     = inject(VoiceChannelService);
  private   navService   = inject(NavigationService);

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

  protected joinChannel(): void {
    const view = this.navService.workspace();
    const guildName = view.type === 'server' ? view.guild.name : '';
    this.voiceSvc.joinChannel(this.channel(), guildName);
    // TODO(backend): initiate WebRTC connection after joinChannel confirms via WebSocket
  }

  protected leaveChannel(): void {
    this.voiceSvc.leaveChannel();
    // TODO(backend): teardown WebRTC tracks before leaving
  }

  protected toggleMute():         void  { this.voiceSvc.toggleMute(); }
  protected toggleDeafen():       void  { this.voiceSvc.toggleDeafen(); }
  protected toggleCamera():       void  { void this.voiceSvc.toggleCamera(); }
  protected toggleScreenShare():  void  { void this.voiceSvc.toggleScreenShare(); }

  protected joinScreenShare(sharer: VoiceChannelParticipant): void {
    // TODO(backend): subscribe to sharer's remote MediaStream via WebRTC
    console.log('Join screen share of', sharer.displayName);
  }

  protected localParticipantLabel(): string {
    return this.participants().find(p => p.userId === this.voiceSvc.channelParticipants().get(this.channel().id)?.[0]?.userId)?.displayName ?? 'You';
  }
}
