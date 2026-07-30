import {ChangeDetectionStrategy, Component, inject, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {InputOtp} from 'primeng/inputotp';
import {Dialog} from 'primeng/dialog';
import {TranslateModule} from '@ngx-translate/core';
import {MfaService} from '../../../../../services/mfa.service';
import {ToastService} from '../../../../../services/toast.service';
import {QrCodeComponent} from '../../../../../components/qr-code/qr-code.component';

type Stage = 'idle' | 'enrolling' | 'enabled';

@Component({
    selector: 'app-security-settings',
    imports: [FormsModule, Button, InputText, InputOtp, Dialog, TranslateModule, QrCodeComponent],
    templateUrl: './security-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SecuritySettingsComponent {
    protected stage = signal<Stage>('idle');
    protected secret = signal('');
    protected otpAuthUri = signal('');
    protected code = signal('');
    protected busy = signal(false);

    /** Shown exactly once, right after enable or regenerate - there is no way to re-read them. */
    protected recoveryCodes = signal<string[] | null>(null);

    protected showDisableDialog = signal(false);
    protected showRegenerateDialog = signal(false);
    protected password = signal('');

    private mfa = inject(MfaService);
    private toast = inject(ToastService);

    protected beginEnroll(): void {
        if (this.busy()) return;
        this.busy.set(true);
        this.mfa.enroll().subscribe({
            next: res => {
                this.secret.set(res.secret);
                this.otpAuthUri.set(res.otpAuthUri);
                this.stage.set('enrolling');
                this.busy.set(false);
            },
            error: err => {
                this.busy.set(false);
                this.toast.httpError('Could not start setup', err);
            },
        });
    }

    protected cancelEnroll(): void {
        this.stage.set('idle');
        this.code.set('');
    }

    protected confirmEnable(): void {
        const code = this.code();
        if (this.busy() || code.length < 6) return;
        this.busy.set(true);
        this.mfa.enable(code).subscribe({
            next: res => {
                this.recoveryCodes.set(res.recoveryCodes);
                this.stage.set('enabled');
                this.code.set('');
                this.busy.set(false);
                this.toast.success('Two-factor authentication enabled');
            },
            error: err => {
                this.busy.set(false);
                // The pending secret stays valid, so let them retype rather than restarting.
                if (err?.status === 400) this.toast.error('That code did not match. Try the current one.');
                else this.toast.httpError('Could not enable two-factor', err);
            },
        });
    }

    protected confirmDisable(): void {
        if (this.busy() || !this.password()) return;
        this.busy.set(true);
        this.mfa.disable(this.password()).subscribe({
            next: () => {
                this.busy.set(false);
                this.showDisableDialog.set(false);
                this.password.set('');
                this.recoveryCodes.set(null);
                this.stage.set('idle');
                this.toast.success('Two-factor authentication disabled');
            },
            error: err => {
                this.busy.set(false);
                if (err?.status === 400) this.toast.error('Incorrect password');
                else this.toast.httpError('Could not disable two-factor', err);
            },
        });
    }

    protected confirmRegenerate(): void {
        if (this.busy() || !this.password()) return;
        this.busy.set(true);
        this.mfa.regenerateRecoveryCodes(this.password()).subscribe({
            next: res => {
                this.busy.set(false);
                this.showRegenerateDialog.set(false);
                this.password.set('');
                this.recoveryCodes.set(res.recoveryCodes);
                this.toast.success('New recovery codes generated');
            },
            error: err => {
                this.busy.set(false);
                if (err?.status === 400) this.toast.error('Incorrect password');
                else this.toast.httpError('Could not regenerate codes', err);
            },
        });
    }

    protected copyCodes(): void {
        const codes = this.recoveryCodes();
        if (!codes) return;
        void navigator.clipboard.writeText(codes.join('\n'));
        this.toast.success('Recovery codes copied');
    }

    protected downloadCodes(): void {
        const codes = this.recoveryCodes();
        if (!codes) return;
        const blob = new Blob([codes.join('\n')], {type: 'text/plain'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'venta-recovery-codes.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    protected dismissCodes(): void {
        this.recoveryCodes.set(null);
    }

    protected copySecret(): void {
        void navigator.clipboard.writeText(this.secret());
        this.toast.success('Secret copied');
    }
}
