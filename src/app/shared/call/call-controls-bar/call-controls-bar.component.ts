import { Component, input, output } from '@angular/core';
import { NgClass } from '@angular/common';
import { StreamResolution } from '../../../services/rust-media.service';

@Component({
  selector: 'app-call-controls-bar',
  imports: [NgClass],
  templateUrl: './call-controls-bar.component.html',
})
export class CallControlsBarComponent {
  // State inputs
  isMuted          = input.required<boolean>();
  isDeafened       = input.required<boolean>();
  isCameraOn       = input.required<boolean>();
  isScreenSharing  = input.required<boolean>();
  screenHasAudio   = input<boolean>(false);
  screenAudioMuted = input<boolean>(false);
  captureFps       = input<number | null>(null);
  captureResolution = input<string | null>(null);
  fpsList          = input<readonly number[]>([5, 10, 15, 30]);
  resolutionList   = input<readonly StreamResolution[]>(['native', '1440p', '1080p', '720p', '480p']);
  disconnectLabel  = input<string>('Disconnect');

  // Action outputs
  muteToggle        = output<void>();
  deafenToggle      = output<void>();
  cameraToggle      = output<void>();
  screenShareToggle = output<void>();
  screenAudioToggle = output<void>();
  fpsChange         = output<number>();
  resolutionChange  = output<StreamResolution>();
  disconnect        = output<void>();
}
