import { Component, input, output } from '@angular/core';
import { NgClass } from '@angular/common';
import { VoiceChannelParticipant } from '../../../../services/voice-channel.service';
import { AppAvatarComponent } from '../../../../components/avatar/avatar.component';
import { StreamSrcDirective } from '../../../../directives/stream-src.directive';

@Component({
  selector: 'app-voice-channel-participant-tile',
  imports: [NgClass, AppAvatarComponent, StreamSrcDirective],
  templateUrl: './voice-channel-participant-tile.component.html',
})
export class VoiceChannelParticipantTileComponent {
  participant = input.required<VoiceChannelParticipant>();
  hasAudio = input.required<boolean>();
  videoStream = input<MediaStream | null>(null);

  contextMenu = output<MouseEvent>();
}
