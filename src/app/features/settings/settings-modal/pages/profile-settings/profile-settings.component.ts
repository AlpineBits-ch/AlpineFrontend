import {ChangeDetectionStrategy, Component, computed, inject, OnInit, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {take} from 'rxjs';
import {FormsModule} from '@angular/forms';
import {DatePipe} from '@angular/common';
import {HttpErrorResponse} from '@angular/common/http';
import {ProfileService} from '../../../../../services/profile.service';
import {UserService} from '../../../../../services/user.service';
import {SteamService} from '../../../../../services/steam.service';
import {ExternalLinkService} from '../../../../../services/external-link.service';
import {ToastService} from '../../../../../services/toast.service';
import {TranslateModule} from '@ngx-translate/core';
import {AccountStatus, UserDto} from '../../../../../dtos/response/UserDto';
import {AccountPhoneComponent} from '../../../components/account-phone.component';

@Component({
    selector: 'app-profile-settings',
    imports: [Button, Dialog, TranslateModule, FormsModule, DatePipe, AccountPhoneComponent],
    templateUrl: './profile-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileSettingsComponent implements OnInit {
    protected readonly user = signal<UserDto | undefined>(undefined);
    protected readonly userLoading = signal(true);
    protected readonly confirmDeleteVisible = signal(false);
    protected readonly deleting = signal(false);
    protected readonly cancelDeleteVisible = signal(false);
    protected readonly cancellingDeletion = signal(false);
    // Password change
    protected readonly currentPassword = signal('');
    protected readonly newPassword = signal('');
    protected readonly confirmPassword = signal('');
    protected readonly showCurrentPw = signal(false);
    protected readonly showNewPw = signal(false);
    protected readonly showConfirmPw = signal(false);
    protected readonly passwordChanging = signal(false);
    protected readonly passwordResult = signal<{code: number; message: string} | null>(null);
    // Sign out all other devices
    protected readonly signOutAllVisible = signal(false);
    protected readonly signingOutAll = signal(false);
    protected readonly signOutSuccess = signal(false);
    protected readonly usernameDisplay = computed(() => this.ownProfile()?.userName ?? '-');
    // Steam link
    protected readonly linkingSteam = signal(false);
    protected readonly unlinkingSteam = signal(false);
    protected readonly unlinkSteamVisible = signal(false);
    protected readonly steamId = computed(() => this.user()?.steamId);
    protected get AccountStatus() {
        return AccountStatus;
    }
    protected readonly accountStatus = computed(() => this.user()?.status ?? AccountStatus.Active);
    private profileService = inject(ProfileService);
    protected ownProfile = this.profileService.ownProfile;
    private userService = inject(UserService);
    private steamService = inject(SteamService);
    private externalLink = inject(ExternalLinkService);
    private toast = inject(ToastService);

    constructor() {
        // The link flow completes asynchronously via the venta://steam-auth deep link.
        // When it resolves, refresh the user so a freshly linked SteamID appears.
        this.steamService.linkResult.pipe(takeUntilDestroyed()).subscribe(status => {
            this.linkingSteam.set(false);
            if (status === 'linked') this.refreshUser();
        });
    }

    protected get passwordMismatch(): boolean {
        return (
            this.newPassword().length > 0 &&
            this.confirmPassword().length > 0 &&
            this.newPassword() !== this.confirmPassword()
        );
    }

    protected get passwordFormValid(): boolean {
        return (
            this.currentPassword().length > 0 &&
            this.newPassword().length >= 8 &&
            this.newPassword() === this.confirmPassword()
        );
    }

    ngOnInit(): void {
        this.userService
            .getSelf()
            .pipe(take(1))
            .subscribe({
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
        this.steamService
            .getLinkStartUrl()
            .pipe(take(1))
            .subscribe({
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
        this.steamService
            .unlink()
            .pipe(take(1))
            .subscribe({
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
        this.userService
            .getSelf()
            .pipe(take(1))
            .subscribe({
                next: user => this.user.set(user),
            });
    }

    protected submitPasswordChange(): void {
        if (!this.passwordFormValid || this.passwordChanging()) return;
        this.passwordChanging.set(true);
        this.passwordResult.set(null);
        this.userService
            .changePassword(this.currentPassword(), this.newPassword())
            .pipe(take(1))
            .subscribe({
                next: ({code}) => {
                    this.passwordChanging.set(false);
                    this.passwordResult.set({code, message: this.passwordCodeMessage(code)});
                    if (code >= 200 && code < 300) {
                        this.currentPassword.set('');
                        this.newPassword.set('');
                        this.confirmPassword.set('');
                    }
                },
            });
    }

    protected confirmSignOutAll(): void {
        this.signingOutAll.set(true);
        this.userService
            .signOutAllOtherDevices()
            .pipe(take(1))
            .subscribe({
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
        this.userService
            .deleteAccount()
            .pipe(take(1))
            .subscribe({
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
        this.userService
            .cancelDeletion()
            .pipe(take(1))
            .subscribe({
                next: user => {
                    this.cancellingDeletion.set(false);
                    this.cancelDeleteVisible.set(false);
                    this.user.set(user);
                    this.toast.success('Account deletion cancelled');
                },
                error: (err: HttpErrorResponse) => {
                    this.cancellingDeletion.set(false);
                    if (err.status === 409) {
                        this.toast.error('Too late to cancel - the deletion has already started.');
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
