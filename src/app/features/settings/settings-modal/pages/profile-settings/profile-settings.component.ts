import { Component, computed, ElementRef, inject, OnInit, signal, ViewChild } from '@angular/core';
import { Button } from 'primeng/button';
import { Dialog } from 'primeng/dialog';
import { Router } from '@angular/router';
import { from, of, switchMap, take } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { ProfileService } from '../../../../../services/profile.service';
import { UserService } from '../../../../../services/user.service';
import { AuthService } from '../../../../../services/auth.service';
import { MlsService } from '../../../../../services/mls.service';
import { ImageCropperComponent } from '../../../../../components/image-cropper/image-cropper.component';
import { TranslateModule } from '@ngx-translate/core';
import { UserDto } from '../../../../../dtos/response/UserDto';

@Component({
  selector: 'app-profile-settings',
  imports: [Button, Dialog, ImageCropperComponent, TranslateModule, FormsModule, DatePipe],
  templateUrl: './profile-settings.component.html',
  styleUrl: './profile-settings.component.css',
})
export class ProfileSettingsComponent implements OnInit {
  private profileService = inject(ProfileService);
  private userService = inject(UserService);
  private authService = inject(AuthService);
  private mlsService = inject(MlsService);
  private router = inject(Router);

  @ViewChild('fileInput') private fileInputRef!: ElementRef<HTMLInputElement>;

  protected ownProfile = this.profileService.ownProfile;
  protected user = signal<UserDto | undefined>(undefined);
  protected userLoading = signal(true);

  protected uploading = signal(false);
  protected avatarExpanded = signal(false);
  protected avatarError = signal(false);

  protected cropVisible = signal(false);
  protected cropSrc = signal('');

  protected confirmDeleteVisible = signal(false);
  protected deleting = signal(false);

  // Password change
  protected currentPassword = '';
  protected newPassword = '';
  protected confirmPassword = '';
  protected showCurrentPw = signal(false);
  protected showNewPw = signal(false);
  protected showConfirmPw = signal(false);
  protected passwordChanging = signal(false);
  protected passwordResult = signal<{ code: number; message: string } | null>(null);

  // Sign out all other devices
  protected signOutAllVisible = signal(false);
  protected signingOutAll = signal(false);
  protected signOutSuccess = signal(false);

  protected avatarLabel = computed(() =>
    (this.ownProfile()?.userName?.[0] ?? '?').toUpperCase()
  );

  protected usernameDisplay = computed(() => {
    const p = this.ownProfile();
    if (!p) return '—';
    return `${p.userName}#${String(p.hash).padStart(4, '0')}`;
  });

  protected get passwordMismatch(): boolean {
    return this.newPassword.length > 0 && this.confirmPassword.length > 0 && this.newPassword !== this.confirmPassword;
  }

  protected get passwordFormValid(): boolean {
    return (
      this.currentPassword.length > 0 &&
      this.newPassword.length >= 8 &&
      this.newPassword === this.confirmPassword
    );
  }

  ngOnInit(): void {
    this.userService.getSelf().pipe(take(1)).subscribe({
      next: user => { this.user.set(user); this.userLoading.set(false); },
      error: () => this.userLoading.set(false),
    });
  }

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

  protected submitPasswordChange(): void {
    if (!this.passwordFormValid || this.passwordChanging()) return;
    this.passwordChanging.set(true);
    this.passwordResult.set(null);
    this.userService.changePassword(this.currentPassword, this.newPassword).pipe(take(1)).subscribe({
      next: ({ code }) => {
        this.passwordChanging.set(false);
        this.passwordResult.set({ code, message: this.passwordCodeMessage(code) });
        if (code >= 200 && code < 300) {
          this.currentPassword = '';
          this.newPassword = '';
          this.confirmPassword = '';
        }
      },
    });
  }

  private passwordCodeMessage(code: number): string {
    if (code >= 200 && code < 300) return 'Password changed successfully.';
    if (code === 401) return 'Current password is incorrect.';
    if (code === 422 || code === 400) return 'New password does not meet requirements.';
    if (code === 429) return 'Too many attempts — please wait before trying again.';
    return `Something went wrong (${code}).`;
  }

  protected confirmSignOutAll(): void {
    this.signingOutAll.set(true);
    this.userService.signOutAllOtherDevices().pipe(take(1)).subscribe({
      next: () => {
        this.signingOutAll.set(false);
        this.signOutSuccess.set(true);
        this.signOutAllVisible.set(false);
      },
      error: () => {
        this.signingOutAll.set(false);
        this.signOutAllVisible.set(false);
      },
    });
  }

  protected confirmDeleteAccount(): void {
    this.deleting.set(true);
    this.userService.deleteAccount().pipe(take(1)).subscribe({
      next: () => this.clearMlsAndLogout(),
      error: () => this.deleting.set(false),
    });
  }

  private clearMlsAndLogout(): void {
    from(this.mlsService.getOrCreateDeviceIdentifier()).pipe(
      switchMap(deviceId => {
        const handle = this.mlsService.keyHandle();
        const unload$ = handle ? this.mlsService.unloadSigningKey(handle) : of(undefined as void);
        return unload$.pipe(
          switchMap(() => this.mlsService.clearStoredSigningKey(deviceId)),
          switchMap(() => this.mlsService.clearStorage()),
          switchMap(() => from(this.mlsService.clearGroupRegistry())),
        );
      }),
    ).subscribe({
      complete: () => { this.authService.logout(); this.router.navigate(['/authentication']); },
      error:    () => { this.authService.logout(); this.router.navigate(['/authentication']); },
    });
  }
}
