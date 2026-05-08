import { Component, HostListener, input, output } from '@angular/core';
import { VoiceChannelParticipant } from '../../../../services/voice-channel.service';

export interface ParticipantMenuData {
  x: number;
  y: number;
  participant: VoiceChannelParticipant;
  volume: number;
}

@Component({
  selector: 'app-voice-channel-context-menu',
  templateUrl: './voice-channel-context-menu.component.html',
  host: { '(click)': '$event.stopPropagation()' }
})
export class VoiceChannelContextMenuComponent {
  menu = input.required<ParticipantMenuData>();
  isSuperadmin = input<boolean>(false);

  close = output<void>();
  volumeChange = output<number>();
  kick = output<void>();
  ban = output<void>();
  serverDeafen = output<void>();

  @HostListener('document:click')
  onDocumentClick(): void { this.close.emit(); }

  @HostListener('document:keydown.escape')
  onEscape(): void { this.close.emit(); }

  onVolumeInput(event: Event): void {
    this.volumeChange.emit(parseInt((event.target as HTMLInputElement).value, 10));
  }
}
