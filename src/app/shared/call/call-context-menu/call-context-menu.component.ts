import { Component, HostListener, input, output } from '@angular/core';
import { CallParticipantMenuData } from '../call.types';

@Component({
  selector: 'app-call-context-menu',
  templateUrl: './call-context-menu.component.html',
  host: { '(click)': '$event.stopPropagation()' }
})
export class CallContextMenuComponent {
  menu         = input.required<CallParticipantMenuData>();
  isSuperadmin = input<boolean>(false);

  close        = output<void>();
  volumeChange = output<number>();
  kick         = output<void>();
  ban          = output<void>();
  serverDeafen = output<void>();

  @HostListener('document:click')
  onDocumentClick(): void { this.close.emit(); }

  @HostListener('document:keydown.escape')
  onEscape(): void { this.close.emit(); }

  onVolumeInput(event: Event): void {
    this.volumeChange.emit(parseInt((event.target as HTMLInputElement).value, 10));
  }
}
