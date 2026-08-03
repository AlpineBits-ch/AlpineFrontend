import {Component, inject, OnInit, signal} from '@angular/core';
import {Router} from '@angular/router';
import {catchError, EMPTY, tap} from 'rxjs';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputOtp} from 'primeng/inputotp';
import {FormsModule} from '@angular/forms';
import {EmailVerificationService, PendingCredentials} from '../../services/email-verification.service';
import {ToastService} from '../../services/toast.service';
import {AuthService} from '../../services/auth.service';
import {UserSettingsService} from '../../services/user-settings.service';
import {SessionTeardownService} from '../../services/session-teardown.service';
import {DeviceIdentityService} from '../../services/device-identity.service';
import {PrimeTemplate} from "primeng/api";

@Component({
    selector: 'app-email-verification-dialog',
    imports: [Dialog, Button, InputOtp, FormsModule, PrimeTemplate],
    templateUrl: './email-verification-dialog.component.html',
})
export class EmailVerificationDialogComponent implements OnInit {
    protected verificationService = inject(EmailVerificationService);
    protected code = signal('');
    protected email = signal('');
    protected loading = signal(false);
    protected resendLoading = signal(false);
    protected resendCooldown = signal(0);
    private toast = inject(ToastService);
    private router = inject(Router);
    private authService = inject(AuthService);
    private userSettings = inject(UserSettingsService);
    private teardown = inject(SessionTeardownService);
    private deviceIdentity = inject(DeviceIdentityService);
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
        this.verificationService.verifyCode(email, code).pipe(
            tap(() => {
                this.loading.set(false);
                const credentials = this.verificationService.pendingCredentials();
                this.verificationService.dismiss();
                this.onVerified(email, credentials);
            }),
            catchError((err) => {
                this.loading.set(false);
                if (err?.status === 400) {
                    this.toast.error('Invalid code', {detail: 'The code you entered is incorrect or has expired.'});
                } else {
                    this.toast.httpError('Verification failed', err);
                }
                return EMPTY;
            })
        ).subscribe();
    }

    protected resend(): void {
        const email = this.email();
        if (!email) return;

        this.resendLoading.set(true);
        this.verificationService.resendCode(email).pipe(
            tap(() => {
                this.resendLoading.set(false);
                this.toast.success('Code sent!', {detail: 'A new verification code has been sent to your email.'});
                this.startResendCooldown();
            }),
            catchError((err) => {
                this.resendLoading.set(false);
                if (err?.status === 400) {
                    this.toast.error('Already verified', {detail: 'This email is already verified.'});
                    this.verificationService.dismiss();
                } else {
                    this.toast.httpError('Failed to resend code', err);
                }
                return EMPTY;
            })
        ).subscribe();
    }

    private onVerified(email: string, credentials: PendingCredentials | null): void {
        if (credentials) {
            this.authService.login(credentials.email, credentials.password).pipe(
                tap(() => {
                    this.toast.success('Email verified!', {detail: 'Welcome to Alpine.'});
                    this.userSettings.load();
                    this.router.navigate(['/overview']);
                }),
                catchError(() => {
                    this.toast.success('Email verified!', {detail: 'You can now sign in.'});
                    this.router.navigate(['/authentication']);
                    return EMPTY;
                })
            ).subscribe();
            return;
        }

        this.toast.success('Email verified!', {detail: 'Your email has been confirmed.'});

        if (this.verificationService.postVerifyAction() === 'navigate-login') {
            void this.signOutToLogin();
        }
    }

    /**
     * Signs out with the same wipe every other sign-out path uses.
     *
     * <p>This one reaches the login screen from an unverified session, which is exactly the state
     * where the account is most likely to be a different one from whoever used the machine last.
     * Leaving the previous account's key material behind here is the same leak as anywhere else.</p>
     */
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
