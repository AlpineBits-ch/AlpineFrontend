import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { ToggleSwitch } from 'primeng/toggleswitch';
import { FormsModule } from '@angular/forms';
import { UserSettingsService } from '../../../../../services/user-settings.service';
import { SoundSettingsService, SoundKey } from '../../../../../services/sound-settings.service';

@Component({
  selector: 'app-notification-settings',
  imports: [ToggleSwitch, FormsModule],
  templateUrl: './notification-settings.component.html',
  styleUrl: './notification-settings.component.css',
})
export class NotificationSettingsComponent {
  protected readonly userSettings = inject(UserSettingsService);
  protected readonly soundSettings = inject(SoundSettingsService);

  protected readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  protected readonly uploadError = signal('');

  private currentUploadKey: SoundKey | null = null;

  protected readonly soundItems: Array<{ key: SoundKey; label: string; description: string }> = [
    { key: 'incomingCall', label: 'Incoming Call',  description: 'Plays when someone calls you.' },
    { key: 'outgoingCall', label: 'Outgoing Call',  description: 'Plays while your call is connecting.' },
    { key: 'message',      label: 'Messages',       description: 'Plays when a new message arrives.' },
  ];

  protected preview(key: SoundKey): void {
    switch (key) {
      case 'incomingCall': this.soundSettings.playIncomingRing(); break;
      case 'outgoingCall': this.soundSettings.playRingback();     break;
      case 'message':      this.soundSettings.playMessage();      break;
    }
  }

  protected triggerUpload(key: SoundKey): void {
    this.currentUploadKey = key;
    this.uploadError.set('');
    this.fileInput()?.nativeElement.click();
  }

  protected onFileSelected(event: Event): void {
    const key = this.currentUploadKey;
    this.currentUploadKey = null;
    if (!key) return;

    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      this.uploadError.set('File too large (max 5 MB).');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      this.soundSettings.update(key, { customUrl: reader.result as string, customName: file.name });
    };
    reader.readAsDataURL(file);
  }

  protected clearCustom(key: SoundKey): void {
    this.soundSettings.update(key, { customUrl: undefined, customName: undefined });
  }

  protected updateVolume(key: SoundKey, pct: number): void {
    this.soundSettings.update(key, { volume: pct / 100 });
  }

  protected getVolumePct(key: SoundKey): number {
    return Math.round(this.soundSettings.settings()[key].volume * 100);
  }
}
