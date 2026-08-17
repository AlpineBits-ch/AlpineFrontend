import {ChangeDetectionStrategy, Component, computed, inject, signal} from '@angular/core';
import {Router} from '@angular/router';
import {catchError, EMPTY, tap} from 'rxjs';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputOtp} from 'primeng/inputotp';
import {InputText} from 'primeng/inputtext';
import {FormsModule} from '@angular/forms';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {MfaChallengeService, mfaErrorKind} from '../../services/mfa-challenge.service';
import {AuthService} from '../../services/auth.service';
import {ToastService} from '../../services/toast.service';
import {UserSettingsService} from '../../services/user-settings.service';

@Component({
    selector: 'app-mfa-challenge-dialog',
    imports: [Dialog, Button, InputOtp, InputText, FormsModule, PrimeTemplate, TranslateModule],
    templateUrl: './mfa-challenge-dialog.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MfaChallengeDialogComponent {
    protected mfaChallenge = inject(MfaChallengeService);
    protected readonly code = signal('');
    protected readonly useRecoveryCode = signal(false);
    protected readonly invalidCode = signal(false);
    protected readonly loading = signal(false);
    protected readonly minCodeLength = computed(() => (this.useRecoveryCode() ? 8 : 6));

    private authService = inject(AuthService);
    private userSettings = inject(UserSettingsService);
    private router = inject(Router);
    private toast = inject(ToastService);

    protected onShow(): void {
        this.code.set('');
        this.useRecoveryCode.set(false);
        this.invalidCode.set(false);
        this.loading.set(false);
    }

    /**
     * The dialog is mounted for the whole app lifetime (see app.component.html), so the
     * entered code would otherwise stay resident in memory indefinitely after the flow ends.
     */
    protected onHide(): void {
        this.code.set('');
    }

    protected toggleRecoveryCode(): void {
        this.useRecoveryCode.update(v => !v);
        this.code.set('');
        this.invalidCode.set(false);
    }

    protected onCodeChange(value: string): void {
        this.code.set(value);
        this.invalidCode.set(false);
    }

    protected submit(): void {
        const code = this.code();
        if (code.length < this.minCodeLength() || this.loading()) return;

        this.loading.set(true);
        this.invalidCode.set(false);
        this.authService
            .login(this.mfaChallenge.username(), this.mfaChallenge.password(), code)
            .pipe(
                tap(() => {
                    this.loading.set(false);
                    this.userSettings.load();
                    void this.router.navigate(['/overview']);
                    this.mfaChallenge.dismiss();
                }),
                catchError(err => {
                    this.loading.set(false);
                    if (mfaErrorKind(err) === 'invalid') {
                        this.invalidCode.set(true);
                        this.code.set('');
                    } else {
                        this.toast.httpError('Sign in failed', err);
                        this.mfaChallenge.dismiss();
                    }
                    return EMPTY;
                }),
            )
            .subscribe();
    }
}
