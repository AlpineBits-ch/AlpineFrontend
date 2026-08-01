import {Component, computed, EventEmitter, inject, Input, Output, signal} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PasswordDirective} from 'primeng/password';
import {MasterKeyStateService} from '../../../services/master-key-state.service';

/**
 * The two repairs a master key can need, and the one loss it cannot.
 *
 * <p>All three states used to be invisible. A password reset left the master key sealed under a
 * forgotten password and the account carried on looking healthy until the first restore attempt
 * failed - by which point nothing could be done about it. Contract §C.1.1 exists to make each of
 * these something the user is told, at the moment it becomes true.</p>
 */
@Component({
    selector: 'app-master-key-recovery-dialog',
    standalone: true,
    imports: [Dialog, Button, PasswordDirective],
    templateUrl: './master-key-recovery-dialog.component.html',
})
export class MasterKeyRecoveryDialogComponent {
    @Input() visible = false;
    @Output() dismissed = new EventEmitter<void>();

    protected readonly state = inject(MasterKeyStateService);

    protected readonly action = computed(() => this.state.action());
    protected busy = signal(false);
    protected errorMsg = signal('');
    protected recoveryCode = signal('');
    protected newPassword = signal('');
    protected password = signal('');
    /** Set once a retrofit produced a code, so it can be shown exactly once. */
    protected generatedCode = signal('');

    protected onRecoveryCodeInput(event: Event): void {
        this.recoveryCode.set((event.target as HTMLInputElement).value);
        this.errorMsg.set('');
    }

    protected onNewPasswordInput(event: Event): void {
        this.newPassword.set((event.target as HTMLInputElement).value);
        this.errorMsg.set('');
    }

    protected onPasswordInput(event: Event): void {
        this.password.set((event.target as HTMLInputElement).value);
        this.errorMsg.set('');
    }

    /** Re-wraps the master key under the new password, using the recovery code. */
    protected async onRewrap(): Promise<void> {
        if (!this.recoveryCode() || !this.newPassword()) {
            this.errorMsg.set('Both the recovery code and your new password are required.');
            return;
        }
        this.busy.set(true);
        try {
            const ok = await this.state.rewrapUnderNewPassword(this.recoveryCode(), this.newPassword());
            if (!ok) {
                this.errorMsg.set('That recovery code did not work. Check it and try again.');
                return;
            }
            this.close();
        } catch {
            this.errorMsg.set('Something went wrong. Please try again.');
        } finally {
            this.busy.set(false);
        }
    }

    /** Adds the second wrapping to an account that predates it. */
    protected async onAddRecoveryCode(): Promise<void> {
        if (!this.password()) {
            this.errorMsg.set('Your password is required.');
            return;
        }
        this.busy.set(true);
        try {
            const code = await this.state.addRecoveryCode(this.password());
            if (!code) {
                // Covers both a wrong password and a write the server did not actually store -
                // showing a code in either case would tell the user they are protected when they
                // are not.
                this.errorMsg.set('Could not set up a recovery code. Check your password and try again.');
                return;
            }
            this.generatedCode.set(code);
        } catch {
            this.errorMsg.set('Something went wrong. Please try again.');
        } finally {
            this.busy.set(false);
        }
    }

    protected async copyCode(): Promise<void> {
        try {
            await navigator.clipboard.writeText(this.generatedCode());
        } catch {
            // It is on screen to be written down regardless.
        }
    }

    protected close(): void {
        this.recoveryCode.set('');
        this.newPassword.set('');
        this.password.set('');
        this.generatedCode.set('');
        this.errorMsg.set('');
        this.dismissed.emit();
    }
}
