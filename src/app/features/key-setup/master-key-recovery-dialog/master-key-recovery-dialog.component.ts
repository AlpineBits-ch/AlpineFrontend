import {Component, computed, EventEmitter, inject, Input, Output, signal} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PasswordDirective} from 'primeng/password';
import {MasterKeyRepair, MasterKeyStateService} from '../../../services/master-key-state.service';

/** Turns a failed repair into something the user can act on. */
function describeRepairFailure(result: MasterKeyRepair, credential: string): string {
    switch (result.outcome) {
        case 'credential-rejected':
            return `That ${credential} did not work. Check it and try again.`;
        case 'not-stored':
            // A code the server did not store opens nothing. Showing it would report the account as
            // protected at the exact moment it is not.
            return (
                'The server accepted the request but did not store the recovery code, so it ' +
                'would not open anything. Nothing has changed - please try again or contact ' +
                'support.'
            );
        case 'not-applicable':
            return 'This account has nothing to repair from. Reload and try again.';
        case 'engine-failed':
            // Named as a local fault, and logged in full. Retrying an argument-rejected command
            // never succeeds, so sending the user round the same loop is worse than saying so.
            console.error('Master-key repair could not run locally', result.detail);
            return (
                `Your ${credential} was not the problem - this device could not run the key ` +
                `operation. Details: ${result.detail}`
            );
        default:
            return 'Something went wrong. Please try again.';
    }
}

function unexpected(err: unknown): string {
    console.error('Master-key repair failed unexpectedly', err);
    return 'Something went wrong. Please try again.';
}

/** The two repairs a master key can need, and the one loss it cannot. */
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
    protected readonly busy = signal(false);
    protected readonly errorMsg = signal('');
    protected readonly recoveryCode = signal('');
    protected readonly newPassword = signal('');
    protected readonly password = signal('');
    /** Set once a retrofit produced a code, so it can be shown exactly once. */
    protected readonly generatedCode = signal('');

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
        // Re-entrancy guard, not just button state: the fields submit on Enter, and a held key
        // repeats. Two rewraps of the same key racing each other is not something to find out
        // about afterwards.
        if (this.busy()) return;
        if (!this.recoveryCode() || !this.newPassword()) {
            this.errorMsg.set('Both the recovery code and your new password are required.');
            return;
        }
        this.busy.set(true);
        try {
            const result = await this.state.rewrapUnderNewPassword(this.recoveryCode(), this.newPassword());
            if (result.outcome === 'ok') {
                this.close();
                return;
            }
            this.errorMsg.set(describeRepairFailure(result, 'recovery code'));
        } catch (err) {
            this.errorMsg.set(unexpected(err));
        } finally {
            this.busy.set(false);
        }
    }

    /** Adds the second wrapping to an account that predates it. */
    protected async onAddRecoveryCode(): Promise<void> {
        // See onRewrap: Enter submits, so the in-flight check belongs here rather than only on
        // the button. A second run would mint a second recovery code and invalidate the first.
        if (this.busy()) return;
        if (!this.password()) {
            this.errorMsg.set('Your password is required.');
            return;
        }
        this.busy.set(true);
        try {
            const result = await this.state.addRecoveryCode(this.password());
            if (result.outcome === 'ok') {
                this.generatedCode.set(result.recoveryCode!);
                return;
            }
            this.errorMsg.set(describeRepairFailure(result, 'password'));
        } catch (err) {
            this.errorMsg.set(unexpected(err));
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
