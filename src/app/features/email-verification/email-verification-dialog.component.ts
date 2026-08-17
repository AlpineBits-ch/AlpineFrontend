import {Component, computed, inject, OnInit, signal} from '@angular/core';
import {Router} from '@angular/router';
import {catchError, EMPTY, tap} from 'rxjs';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputOtp} from 'primeng/inputotp';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {EmailVerificationService, PendingCredentials} from '../../services/email-verification.service';
import {ToastService} from '../../services/toast.service';
import {AuthService} from '../../services/auth.service';
import {UserSettingsService} from '../../services/user-settings.service';
import {SessionTeardownService} from '../../services/session-teardown.service';
import {DeviceIdentityService} from '../../services/device-identity.service';
import {PasswordResetDialogService} from '../password-reset/password-reset.service';
import {PrimeTemplate} from 'primeng/api';

@Component({
    selector: 'app-email-verification-dialog',
    imports: [Dialog, Button, InputOtp, FormsModule, PrimeTemplate, TranslateModule],
    templateUrl: './email-verification-dialog.component.html',
})
export class EmailVerificationDialogComponent implements OnInit {
    protected verificationService = inject(EmailVerificationService);
    protected readonly code = signal('');
    protected readonly email = signal('');
    protected readonly loading = signal(false);
    protected readonly resendLoading = signal(false);
    protected readonly resendCooldown = signal(0);

    /**
     * True when we cannot promise a code is in the inbox - the state registration leaves the user
     * in. Switches the copy to the conditional wording and reveals the sign-in and password-reset
     * links, which for someone whose address already had a verified account are, together with the
     * notice the server mailed them, the entire recovery path.
     */
    protected readonly uncertain = computed(() => this.verificationService.certainty() === 'unknown');

    private toast = inject(ToastService);
    private router = inject(Router);
    private authService = inject(AuthService);
    private userSettings = inject(UserSettingsService);
    private teardown = inject(SessionTeardownService);
    private deviceIdentity = inject(DeviceIdentityService);
    private passwordResetDialog = inject(PasswordResetDialogService);
    private translate = inject(TranslateService);
    private cooldownTimer: ReturnType<typeof setInterval> | null = null;

    ngOnInit(): void {
        this.email.set(this.verificationService.email());
    }

    protected onShow(): void {
        this.code.set('');
        this.email.set(this.verificationService.email());
        this.resendCooldown.set(0);
        if (this.cooldownTimer) clearInterval(this.cooldownTimer);
    }

    protected verify(): void {
        const code = this.code();
        const email = this.email();
        if (!code || code.length < 6) return;

        this.loading.set(true);
        this.verificationService
            .verifyCode(email, code)
            .pipe(
                tap(() => {
                    this.loading.set(false);
                    const credentials = this.verificationService.pendingCredentials();
                    this.verificationService.dismiss();
                    this.onVerified(email, credentials);
                }),
                catchError(err => {
                    this.loading.set(false);
                    if (err?.status === 400) {
                        // The one refusal this endpoint makes, and it covers wrong code, expired code,
                        // too many wrong guesses, unknown address and already-verified account alike.
                        // Nothing here may be narrowed into a statement about whether the address exists.
                        this.toast.error(this.translate.instant('LOGIN.VERIFY.INVALID_CODE'), {
                            detail: this.translate.instant('LOGIN.VERIFY.INVALID_CODE_DETAIL'),
                        });
                    } else {
                        this.toast.httpError(this.translate.instant('LOGIN.VERIFY.FAILED'), err);
                    }
                    return EMPTY;
                }),
            )
            .subscribe();
    }

    protected resend(): void {
        const email = this.email();
        if (!email) return;

        this.resendLoading.set(true);
        this.verificationService
            .resendCode(email)
            .pipe(
                tap(() => {
                    this.resendLoading.set(false);
                    this.toast.success(this.translate.instant('LOGIN.VERIFY.RESENT'), {
                        detail: this.translate.instant('LOGIN.VERIFY.RESENT_DETAIL'),
                    });
                    this.startResendCooldown();
                }),
                catchError(err => {
                    // No status-specific branches: this endpoint answers 202 for every address, existing
                    // or not. Reading "already verified" out of a 400 here would hand back the account
                    // enumeration oracle the uniform response exists to remove.
                    this.resendLoading.set(false);
                    this.toast.httpError(this.translate.instant('LOGIN.VERIFY.RESEND_FAILED'), err);
                    return EMPTY;
                }),
            )
            .subscribe();
    }

    /** For the user who turns out to already have an account: leave, and sign in instead. */
    protected goToSignIn(): void {
        this.verificationService.dismiss();
        void this.router.navigate(['/authentication']);
    }

    protected openPasswordReset(): void {
        const email = this.email();
        this.verificationService.dismiss();
        void this.router.navigate(['/authentication']).then(() => {
            this.passwordResetDialog.show(email.includes('@') ? email : '');
        });
    }

    private onVerified(email: string, credentials: PendingCredentials | null): void {
        if (credentials) {
            this.authService
                .login(credentials.loginId, credentials.password)
                .pipe(
                    tap(() => {
                        this.toast.success(this.translate.instant('LOGIN.VERIFY.VERIFIED'), {
                            detail: this.translate.instant('LOGIN.VERIFY.VERIFIED_WELCOME'),
                        });
                        this.userSettings.load();
                        this.router.navigate(['/overview']);
                    }),
                    catchError(() => {
                        this.toast.success(this.translate.instant('LOGIN.VERIFY.VERIFIED'), {
                            detail: this.translate.instant('LOGIN.VERIFY.VERIFIED_SIGN_IN'),
                        });
                        this.router.navigate(['/authentication']);
                        return EMPTY;
                    }),
                )
                .subscribe();
            return;
        }

        this.toast.success(this.translate.instant('LOGIN.VERIFY.VERIFIED'), {
            detail: this.translate.instant('LOGIN.VERIFY.VERIFIED_CONFIRMED'),
        });

        if (this.verificationService.postVerifyAction() === 'navigate-login') {
            void this.signOutToLogin();
        }
    }

    /** Signs out with the same wipe every other sign-out path uses. */
    private async signOutToLogin(): Promise<void> {
        try {
            await this.teardown.wipeAccount(await this.deviceIdentity.deviceId());
        } catch (err) {
            console.error('Could not fully wipe local MLS state on sign-out', err);
        }
        this.authService.logout();
        void this.router.navigate(['/authentication']);
    }

    private startResendCooldown(): void {
        this.resendCooldown.set(60);
        if (this.cooldownTimer) clearInterval(this.cooldownTimer);
        this.cooldownTimer = setInterval(() => {
            const remaining = this.resendCooldown() - 1;
            if (remaining <= 0) {
                this.resendCooldown.set(0);
                clearInterval(this.cooldownTimer!);
                this.cooldownTimer = null;
            } else {
                this.resendCooldown.set(remaining);
            }
        }, 1000);
    }
}
