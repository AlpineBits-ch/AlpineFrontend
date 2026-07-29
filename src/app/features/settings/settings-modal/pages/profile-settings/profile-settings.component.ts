import {Component, computed, effect, ElementRef, inject, OnInit, signal, ViewChild} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {Select} from 'primeng/select';
import {finalize, take} from 'rxjs';
import {FormsModule} from '@angular/forms';
import {DatePipe} from '@angular/common';
import {HttpErrorResponse} from '@angular/common/http';
import {ProfileService} from '../../../../../services/profile.service';
import {UserService} from '../../../../../services/user.service';
import {SteamService} from '../../../../../services/steam.service';
import {ExternalLinkService} from '../../../../../services/external-link.service';
import {ToastService} from '../../../../../services/toast.service';
import {ImageCropperComponent} from '../../../../../components/image-cropper/image-cropper.component';
import {TranslateModule} from '@ngx-translate/core';
import {AccountStatus, UserDto} from '../../../../../dtos/response/UserDto';
import {FONT_LABELS, FONT_STACKS, safeAccentColor} from '../../../../../models/profile-font.model';
import {cacheBustedUrl} from '../../../../../models/profile-image.model';
import {ProfileFont} from '../../../../../dtos/response/profile.dto';

@Component({
    selector: 'app-profile-settings',
    imports: [Button, Dialog, ImageCropperComponent, TranslateModule, FormsModule, DatePipe, Select],
    templateUrl: './profile-settings.component.html',
    styleUrl: './profile-settings.component.css',
})
export class ProfileSettingsComponent implements OnInit {
    protected user = signal<UserDto | undefined>(undefined);
    protected userLoading = signal(true);
    protected uploading = signal(false);
    protected avatarExpanded = signal(false);
    protected avatarError = signal(false);
    protected cropVisible = signal(false);
    protected cropSrc = signal('');
    protected uploadingBanner = signal(false);
    protected bannerCropVisible = signal(false);
    protected bannerCropSrc = signal('');
    protected readonly fontOptions = (Object.entries(FONT_LABELS) as [ProfileFont, string][])
        .map(([value, label]) => ({value, label}));
    protected readonly FONT_STACKS = FONT_STACKS;
    protected readonly safeAccentColor = safeAccentColor;
    protected readonly cacheBustedUrl = cacheBustedUrl;
    protected bioEdit = signal('');
    protected accentColorEdit = signal('');
    protected fontEdit = signal<ProfileFont>(ProfileFont.Default);
    protected savingDetails = signal(false);
    protected confirmDeleteVisible = signal(false);
    protected deleting = signal(false);
    protected cancelDeleteVisible = signal(false);
    protected cancellingDeletion = signal(false);
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
    protected usernameDisplay = computed(() => this.ownProfile()?.userName ?? '-');
    // Steam link
    protected linkingSteam = signal(false);
    protected unlinkingSteam = signal(false);
    protected unlinkSteamVisible = signal(false);
    protected steamId = computed(() => this.user()?.steamId);
    protected readonly AccountStatus = AccountStatus;
    protected accountStatus = computed(() => this.user()?.status ?? AccountStatus.Active);
    private profileService = inject(ProfileService);
    protected ownProfile = this.profileService.ownProfile;
    private userService = inject(UserService);
    private steamService = inject(SteamService);
    private externalLink = inject(ExternalLinkService);
    private toast = inject(ToastService);
    @ViewChild('fileInput') private fileInputRef!: ElementRef<HTMLInputElement>;
    @ViewChild('bannerFileInput') private bannerFileInputRef!: ElementRef<HTMLInputElement>;
    private detailsSynced = false;

    constructor() {
        // The link flow completes asynchronously via the venta://steam-auth deep link.
        // When it resolves, refresh the user so a freshly linked SteamID appears.
        this.steamService.linkResult.pipe(takeUntilDestroyed()).subscribe(status => {
            this.linkingSteam.set(false);
            if (status === 'linked') this.refreshUser();
        });

        // ownProfile may not be populated yet when this page mounts; sync the edit
        // signals only the first time it becomes available so we don't stomp
        // in-progress edits on later profile updates (e.g. right after a save).
        effect(() => {
            const profile = this.ownProfile();
            if (profile && !this.detailsSynced) {
                this.detailsSynced = true;
                this.bioEdit.set(profile.bio ?? '');
                this.accentColorEdit.set(profile.accentColor ?? '');
                this.fontEdit.set(profile.font ?? ProfileFont.Default);
            }
        });
    }

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
            next: user => {
                this.user.set(user);
                this.userLoading.set(false);
            },
            error: () => this.userLoading.set(false),
        });
    }

    protected linkSteam(): void {
        if (this.linkingSteam()) return;
        this.linkingSteam.set(true);
        this.steamService.getLinkStartUrl().pipe(take(1)).subscribe({
            next: ({redirectUrl}) => {
                // Steam login opens in the browser; the result returns via the
                // venta://steam-auth deep link handled in AppComponent/SteamService.
                void this.externalLink.openExternalLink(redirectUrl);
            },
            error: err => {
                this.linkingSteam.set(false);
                this.toast.httpError('Could not start Steam linking', err);
            },
        });
    }

    protected unlinkSteam(): void {
        if (this.unlinkingSteam()) return;
        this.unlinkingSteam.set(true);
        this.steamService.unlink().pipe(take(1)).subscribe({
            next: () => {
                this.unlinkingSteam.set(false);
                this.unlinkSteamVisible.set(false);
                this.toast.success('Steam account unlinked');
                this.refreshUser();
            },
            error: err => {
                this.unlinkingSteam.set(false);
                this.toast.httpError('Could not unlink Steam', err);
            },
        });
    }

    private refreshUser(): void {
        this.userService.getSelf().pipe(take(1)).subscribe({
            next: user => this.user.set(user),
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
        this.profileService.uploadAvatar(file).pipe(
            finalize(() => this.uploading.set(false)),
        ).subscribe({
            next: () => this.avatarError.set(false),
            error: err => this.toast.httpError('Could not upload avatar', err),
        });
    }

    protected onAvatarError(): void {
        this.avatarError.set(true);
    }

    protected removeAvatar(): void {
        this.profileService.removeAvatar().subscribe();
    }

    protected detailsDirty = computed(() => {
        const p = this.ownProfile();
        return this.bioEdit() !== (p?.bio ?? '')
            || this.accentColorEdit() !== (p?.accentColor ?? '')
            || this.fontEdit() !== (p?.font ?? ProfileFont.Default);
    });

    protected fontStackPreview = computed(() => FONT_STACKS[this.fontEdit()]);

    protected saveDetails(): void {
        if (!this.detailsDirty() || this.savingDetails()) return;
        this.savingDetails.set(true);
        this.profileService.updateProfile({
            bio: this.bioEdit(),
            accentColor: this.accentColorEdit(),
            font: this.fontEdit(),
        }).pipe(
            finalize(() => this.savingDetails.set(false)),
        ).subscribe({
            error: err => this.toast.httpError('Could not save profile changes', err),
        });
    }

    protected pickBannerFile(): void {
        this.bannerFileInputRef.nativeElement.click();
    }

    protected onBannerFileSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            this.bannerCropSrc.set(reader.result as string);
            this.bannerCropVisible.set(true);
        };
        reader.readAsDataURL(file);
    }

    protected onBannerCropConfirmed(file: File): void {
        this.bannerCropVisible.set(false);
        this.uploadingBanner.set(true);
        this.profileService.uploadBanner(file).pipe(
            finalize(() => this.uploadingBanner.set(false)),
        ).subscribe({
            error: err => this.toast.httpError('Could not upload banner', err),
        });
    }

    protected submitPasswordChange(): void {
        if (!this.passwordFormValid || this.passwordChanging()) return;
        this.passwordChanging.set(true);
        this.passwordResult.set(null);
        this.userService.changePassword(this.currentPassword, this.newPassword).pipe(take(1)).subscribe({
            next: ({code}) => {
                this.passwordChanging.set(false);
                this.passwordResult.set({code, message: this.passwordCodeMessage(code)});
                if (code >= 200 && code < 300) {
                    this.currentPassword = '';
                    this.newPassword = '';
                    this.confirmPassword = '';
                }
            },
        });
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
            next: user => {
                this.deleting.set(false);
                this.confirmDeleteVisible.set(false);
                this.user.set(user);
                this.toast.success('Account deletion scheduled');
            },
            error: (err: HttpErrorResponse) => {
                this.deleting.set(false);
                this.toast.httpError('Could not delete account', err);
            },
        });
    }

    protected confirmCancelDeletion(): void {
        this.cancellingDeletion.set(true);
        this.userService.cancelDeletion().pipe(take(1)).subscribe({
            next: user => {
                this.cancellingDeletion.set(false);
                this.cancelDeleteVisible.set(false);
                this.user.set(user);
                this.toast.success('Account deletion cancelled');
            },
            error: (err: HttpErrorResponse) => {
                this.cancellingDeletion.set(false);
                if (err.status === 409) {
                    this.toast.error('Too late to cancel — the deletion has already started.');
                } else {
                    this.toast.httpError('Could not cancel account deletion', err);
                }
            },
        });
    }

    private passwordCodeMessage(code: number): string {
        if (code >= 200 && code < 300) return 'Password changed successfully.';
        if (code === 401) return 'Current password is incorrect.';
        if (code === 422 || code === 400) return 'New password does not meet requirements.';
        if (code === 429) return 'Too many attempts -please wait before trying again.';
        return `Something went wrong (${code}).`;
    }
}
