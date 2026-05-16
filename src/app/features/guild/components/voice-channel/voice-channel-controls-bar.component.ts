import { Component, inject, output } from '@angular/core';
import { NgClass } from '@angular/common';
import { VoiceChannelService } from '../../../../services/voice-channel.service';
import { RustMediaService, StreamResolution } from '../../../../services/rust-media.service';

@Component({
  selector: 'app-voice-channel-controls-bar',
  imports: [NgClass],
  templateUrl: './voice-channel-controls-bar.component.html',
})
export class VoiceChannelControlsBarComponent {
  protected voiceSvc  = inject(VoiceChannelService);
  protected rustMedia = inject(RustMediaService);

  readonly fpsList        = [5, 10, 15, 30] as const;
  readonly resolutionList = ['native', '1440p', '1080p', '720p', '480p'] as const;

  muteToggle        = output<void>();
  deafenToggle      = output<void>();
  cameraToggle      = output<void>();
  screenShareToggle = output<void>();
  fpsChange         = output<number>();
  resolutionChange  = output<StreamResolution>();
  disconnect        = output<void>();
}
