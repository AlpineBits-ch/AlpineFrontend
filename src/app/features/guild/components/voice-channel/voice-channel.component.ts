import { Component, computed, inject, input } from '@angular/core';
import { NgClass } from '@angular/common';
import { ChannelDto } from '../../../../dtos/response/guild.dto';
import { VoiceChannelService } from '../../../../services/voice-channel.service';
import { NavigationService } from '../../../main-page/navigation.service';
import { AppAvatarComponent } from '../../../../components/avatar/avatar.component';
import { StreamSrcDirective } from '../../../../directives/stream-src.directive';

@Component({
  selector: 'app-voice-channel',
  imports: [NgClass, AppAvatarComponent, StreamSrcDirective],
  templateUrl: './voice-channel.component.html',
})
export class VoiceChannelComponent {
  channel = input.required<ChannelDto>();

  protected voiceSvc   = inject(VoiceChannelService);
  protected navService = inject(NavigationService);

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
    void this.voiceSvc.joinChannel(this.channel(), guildName);
  }

  protected leaveChannel(): void {
    void this.voiceSvc.leaveChannel();
  }

  protected toggleMute():        void { this.voiceSvc.toggleMute(); }
  protected toggleDeafen():      void { this.voiceSvc.toggleDeafen(); }
  protected toggleCamera():      void { void this.voiceSvc.toggleCamera(); }
  protected toggleScreenShare(): void { void this.voiceSvc.toggleScreenShare(); }

  protected videoStreamFor(userId: string):  MediaStream | null { return this.voiceSvc.getVideoStream(userId); }
  protected screenStreamFor(userId: string): MediaStream | null { return this.voiceSvc.getScreenStream(userId); }

  protected isScreenAudioMuted(userId: string): boolean { return this.voiceSvc.isScreenAudioMuted(userId); }
  protected toggleScreenAudioMute(userId: string): void  { this.voiceSvc.toggleScreenAudioMute(userId); }
  protected toggleLocalScreenAudio(): void { this.voiceSvc.toggleLocalScreenAudio(); }
}
