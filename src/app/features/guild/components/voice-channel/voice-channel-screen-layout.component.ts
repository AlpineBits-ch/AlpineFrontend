import { Component, inject, input, output } from '@angular/core';
import { NgClass } from '@angular/common';
import { VoiceChannelParticipant, VoiceChannelService } from '../../../../services/voice-channel.service';
import { RustMediaService } from '../../../../services/rust-media.service';
import { AppAvatarComponent } from '../../../../components/avatar/avatar.component';
import { StreamSrcDirective } from '../../../../directives/stream-src.directive';

export interface ScreenLayoutContextMenuEvent {
  event: MouseEvent;
  participant: VoiceChannelParticipant;
}

@Component({
  selector: 'app-voice-channel-screen-layout',
  imports: [NgClass, AppAvatarComponent, StreamSrcDirective],
  templateUrl: './voice-channel-screen-layout.component.html',
})
export class VoiceChannelScreenLayoutComponent {
  protected voiceSvc  = inject(VoiceChannelService);
  protected rustMedia = inject(RustMediaService);

  screenSharers = input.required<VoiceChannelParticipant[]>();
  participants  = input.required<VoiceChannelParticipant[]>();

  participantContextMenu = output<ScreenLayoutContextMenuEvent>();

  protected pipShare(event: MouseEvent): void {
    event.stopPropagation();
    const tile = (event.currentTarget as HTMLElement).closest('.relative') as HTMLElement | null;
    const video = tile?.querySelector('video') as HTMLVideoElement | null;
    if (!video || !document.pictureInPictureEnabled) return;
    if (document.pictureInPictureElement === video) {
      document.exitPictureInPicture().catch(() => {});
    } else {
      video.requestPictureInPicture().catch(() => {});
    }
  }
}
