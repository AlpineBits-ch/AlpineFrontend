import { Component, computed, ElementRef, inject, signal, ViewChild } from '@angular/core';
import { Button } from 'primeng/button';
import { Dialog } from 'primeng/dialog';
import { ProfileService } from '../../../../../services/profile.service';

@Component({
  selector: 'app-profile-settings',
  imports: [Button, Dialog],
  templateUrl: './profile-settings.component.html',
  styleUrl: './profile-settings.component.css',
})
export class ProfileSettingsComponent {
  private profileService = inject(ProfileService);

  @ViewChild('fileInput') private fileInputRef!: ElementRef<HTMLInputElement>;

  protected ownProfile = this.profileService.ownProfile;
  protected uploading = signal(false);
  protected avatarExpanded = signal(false);

  protected avatarLabel = computed(() =>
    (this.ownProfile()?.userName?.[0] ?? '?').toUpperCase()
  );

  protected pickFile(): void {
    this.fileInputRef.nativeElement.click();
  }

  protected onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.uploading.set(true);
    this.profileService.uploadAvatar(file).subscribe({
      next: () => this.uploading.set(false),
      error: () => this.uploading.set(false),
    });
  }

  protected removeAvatar(): void {
    this.profileService.removeAvatar().subscribe();
  }
}
