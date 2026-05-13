import { Component, computed, ElementRef, inject, signal, ViewChild } from '@angular/core';
import { Button } from 'primeng/button';
import { Dialog } from 'primeng/dialog';
import { ProfileService } from '../../../../../services/profile.service';
import { ImageCropperComponent } from '../../../../../components/image-cropper/image-cropper.component';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-profile-settings',
  imports: [Button, Dialog, ImageCropperComponent, TranslateModule],
  templateUrl: './profile-settings.component.html',
  styleUrl: './profile-settings.component.css',
})
export class ProfileSettingsComponent {
  private profileService = inject(ProfileService);

  @ViewChild('fileInput') private fileInputRef!: ElementRef<HTMLInputElement>;

  protected ownProfile = this.profileService.ownProfile;
  protected uploading = signal(false);
  protected avatarExpanded = signal(false);
  protected avatarError = signal(false);

  protected cropVisible = signal(false);
  protected cropSrc = signal('');

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

    const reader = new FileReader();
    reader.onload = () => {
      this.cropSrc.set(reader.result as string);
      this.cropVisible.set(true);
    };
    reader.readAsDataURL(file);
  }

  protected onCropConfirmed(file: File): void {
    this.cropVisible.set(false);
    this.uploading.set(true);
    this.profileService.uploadAvatar(file).subscribe({
      next: () => { this.uploading.set(false); this.avatarError.set(false); },
      error: () => this.uploading.set(false),
    });
  }

  protected onAvatarError(): void {
    this.avatarError.set(true);
  }

  protected removeAvatar(): void {
    this.profileService.removeAvatar().subscribe();
  }
}
