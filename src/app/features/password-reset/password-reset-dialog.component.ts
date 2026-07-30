import {ChangeDetectionStrategy, Component, inject, signal} from '@angular/core';
import {catchError, EMPTY, of, tap} from 'rxjs';
import {HttpErrorResponse} from '@angular/common/http';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {FormsModule} from '@angular/forms';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {PasswordResetDialogService} from './password-reset.service';
import {PasswordResetService} from '../../services/password-reset.service';
import {ToastService} from '../../services/toast.service';

type Stage = 'request' | 'reset';

@Component({
    selector: 'app-password-reset-dialog',
    imports: [Dialog, Button, InputText, FormsModule, PrimeTemplate, TranslateModule],
    templateUrl: './password-reset-dialog.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PasswordResetDialogComponent {
    protected dialogService = inject(PasswordResetDialogService);

    protected stage = signal<Stage>('request');
    protected email = signal('');
    protected code = signal('');
    protected newPassword = signal('');
    protected confirmPassword = signal('');

    protected passwordMismatch = signal(false);
    protected invalidCode = signal(false);
    protected newPasswordErrors = signal<string[]>([]);

    protected requestLoading = signal(false);
    protected resetLoading = signal(false);
    protected resendLoading = signal(false);
    protected resendCooldown = signal(0);

    private passwordResetService = inject(PasswordResetService);
    private toast = inject(ToastService);
    private cooldownTimer: ReturnType<typeof setInterval> | null = null;

    protected onShow(): void {
        this.resetState();
    }

    /**
     * The dialog is mounted for the whole app lifetime (see app.component.html), so its
     * signals - including the typed reset code and new password - would otherwise stay
     * resident in memory indefinitely after the flow ends. Reset on hide as well as on show,
     * via the same private method, so the two paths cannot drift apart.
     */
    protected onHide(): void {
        this.resetState();
    }

    private resetState(): void {
        this.stage.set('request');
        this.email.set(this.dialogService.prefillEmail());
        this.code.set('');
        this.newPassword.set('');
        this.confirmPassword.set('');
        this.passwordMismatch.set(false);
        this.invalidCode.set(false);
        this.newPasswordErrors.set([]);
        this.requestLoading.set(false);
        this.resetLoading.set(false);
        this.resendLoading.set(false);
        this.resendCooldown.set(0);
        if (this.cooldownTimer) {
            clearInterval(this.cooldownTimer);
            this.cooldownTimer = null;
        }
    }

    /**
     * The endpoint always returns 202, whether or not the account exists - this is
     * deliberate so the response can't be used to probe which emails are registered.
     * We must therefore advance to the 'reset' stage on ANY outcome, success or error,
     * and never branch on or surface the result.
     */
    protected requestReset(): void {
        const email = this.email().trim();
        if (!email || this.requestLoading()) return;

        this.requestLoading.set(true);
        this.passwordResetService.requestReset(email).pipe(
            catchError(() => of(undefined)),
            tap(() => {
                this.requestLoading.set(false);
                this.stage.set('reset');
                this.startResendCooldown();
            })
        ).subscribe();
    }

    protected resend(): void {
        const email = this.email().trim();
        if (!email || this.resendLoading() || this.resendCooldown() > 0) return;

        this.resendLoading.set(true);
        this.passwordResetService.requestReset(email).pipe(
            catchError(() => of(undefined)),
            tap(() => {
                this.resendLoading.set(false);
                this.toast.info('Code requested', {detail: 'If an account exists for this email, a new code has been sent.'});
                this.startResendCooldown();
            })
        ).subscribe();
    }

    protected onNewPasswordChange(value: string): void {
        this.newPassword.set(value);
        this.passwordMismatch.set(false);
        this.newPasswordErrors.set([]);
    }

    protected onConfirmPasswordChange(value: string): void {
        this.confirmPassword.set(value);
        this.passwordMismatch.set(false);
    }

    protected onCodeChange(value: string): void {
        this.code.set(value);
        this.invalidCode.set(false);
    }

    protected resetPassword(): void {
        const email = this.email().trim();
        const code = this.code().trim();
        const newPassword = this.newPassword();
        const confirmPassword = this.confirmPassword();

        if (newPassword !== confirmPassword) {
            this.passwordMismatch.set(true);
            return;
        }
        this.passwordMismatch.set(false);

        if (!code || code.length < 6 || !newPassword || this.resetLoading()) return;

        this.invalidCode.set(false);
        this.newPasswordErrors.set([]);
        this.resetLoading.set(true);
        this.passwordResetService.resetPassword(email, code, newPassword).pipe(
            tap(() => {
                this.resetLoading.set(false);
                this.toast.success('Password changed', {detail: 'You can now sign in with your new password.'});
                this.dialogService.dismiss();
            }),
            catchError((err: unknown) => {
                this.resetLoading.set(false);
                if (err instanceof HttpErrorResponse && err.status === 400) {
                    const validationErrors: string[] | undefined = err.error?.errors?.newPassword;
                    if (Array.isArray(validationErrors) && validationErrors.length > 0) {
                        this.newPasswordErrors.set(validationErrors);
                    } else {
                        this.invalidCode.set(true);
                    }
                } else {
                    this.toast.httpError('Password reset failed', err);
                }
                return EMPTY;
            })
        ).subscribe();
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
