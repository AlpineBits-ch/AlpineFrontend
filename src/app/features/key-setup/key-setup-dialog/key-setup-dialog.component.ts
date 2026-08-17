import {Component, EventEmitter, inject, Input, Output, signal} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PasswordDirective} from 'primeng/password';
import {EntropyModalComponent} from '../entropy-modal/entropy-modal.component';
import {HttpErrorResponse} from '@angular/common/http';
import {UserService} from '../../../services/user.service';
import {MasterKeyEngineError, MasterKeyService} from '../../../services/master-key.service';
import {BackupService, toWrappingDto} from '../../../services/backup.service';
import {OsInfo} from '../../../platform/ports/os-info.port';
import {AppInfoService} from '../../../services/app-info.service';
import {catchError, EMPTY, filter, from, switchMap, take, tap} from 'rxjs';
import {TranslateModule} from '@ngx-translate/core';

/** `recovery-code` and `confirm-code` sit between entropy collection and the upload deliberately. */
type Step =
    | 'password'
    | 'entropy'
    | 'recovery-code'
    | 'confirm-code'
    | 'processing'
    | 'done';

@Component({
    selector: 'app-key-setup-dialog',
    standalone: true,
    imports: [Dialog, Button, PasswordDirective, EntropyModalComponent, TranslateModule],
    templateUrl: './key-setup-dialog.component.html',
    styleUrl: './key-setup-dialog.component.css',
})
export class KeySetupDialogComponent {
    @Input() visible = false;
    /** Whether the user may back out. */
    @Input() dismissible = false;
    @Output() setupComplete = new EventEmitter<void>();
    @Output() dismissed = new EventEmitter<void>();

    protected readonly step = signal<Step>('password');
    protected readonly password = signal('');
    protected readonly errorMsg = signal('');
    /** Shown once, on the `recovery-code` step, and never retrievable afterwards. */
    protected readonly recoveryCode = signal('');
    /** What the user types back on `confirm-code`. */
    protected readonly confirmation = signal('');
    protected readonly copied = signal(false);

    protected readonly appInfo = inject(AppInfoService);
    private userService = inject(UserService);
    private masterKeyService = inject(MasterKeyService);
    private backupService = inject(BackupService);
    private os = inject(OsInfo);
    /** Entropy collected before the recovery-code steps, carried through to the upload. */
    private collectedEntropy: number[] = [];

    /** Whether to collect mouse-movement entropy before minting the recovery code. */
    private readonly showEntropy =
        !this.os.isMobile &&
        window.matchMedia('(pointer: fine)').matches;

    /** Backs out of a deferred prompt, leaving nothing behind. */
    protected dismiss(): void {
        this.password.set('');
        this.errorMsg.set('');
        this.dismissed.emit();
    }

    protected onPasswordInput(event: Event): void {
        this.password.set((event.target as HTMLInputElement).value);
    }

    protected onContinue(): void {
        if (!this.password()) {
            this.errorMsg.set('Password is required.');
            return;
        }
        this.errorMsg.set('');
        this.userService.verifyPassword(this.password()).pipe(
            take(1),
            filter(valid => {
                if (!valid) {
                    this.errorMsg.set('Incorrect password. Please try again.');
                }
                return valid;
            }),
        ).subscribe(() => {
            if (this.showEntropy) {
                this.step.set('entropy');
            } else {
                void this.toRecoveryCode([]);
            }
        });
    }

    protected onEntropyDone(entropy: number[]): void {
        void this.toRecoveryCode(entropy);
    }

    protected async copyRecoveryCode(): Promise<void> {
        try {
            await navigator.clipboard.writeText(this.recoveryCode());
            this.copied.set(true);
        } catch {
            // Clipboard access can be refused; the code is on screen to be written down anyway.
            this.copied.set(false);
        }
    }

    protected onConfirmationInput(event: Event): void {
        this.confirmation.set((event.target as HTMLInputElement).value);
        this.errorMsg.set('');
    }

    protected toConfirmStep(): void {
        this.confirmation.set('');
        this.errorMsg.set('');
        this.step.set('confirm-code');
    }

    protected backToCode(): void {
        this.errorMsg.set('');
        this.step.set('recovery-code');
    }

    /** Checks the retyped code before anything is generated. */
    protected async onConfirmCode(): Promise<void> {
        let typed: string;
        let expected: string;
        try {
            [typed, expected] = await Promise.all([
                this.masterKeyService.normalizeRecoveryCode(this.confirmation()),
                this.masterKeyService.normalizeRecoveryCode(this.recoveryCode()),
            ]);
        } catch (err) {
            // A code we just generated always normalises, so this is the typed one being malformed
            // - unless the engine itself refused, which is reported as itself rather than as a
            // mistyped code.
            if (err instanceof MasterKeyEngineError) {
                console.error('Recovery-code check could not run', err.detail);
                this.errorMsg.set('This device could not check the code. ' + err.detail);
                return;
            }
            this.errorMsg.set("That doesn't match. Check the code and try again.");
            return;
        }

        if (typed !== expected) {
            this.errorMsg.set("That doesn't match. Check the code and try again.");
            return;
        }
        this.errorMsg.set('');
        this.execute(this.collectedEntropy);
    }

    private async toRecoveryCode(entropy: number[]): Promise<void> {
        this.collectedEntropy = entropy;
        try {
            this.recoveryCode.set(await this.masterKeyService.generateRecoveryCode());
            this.copied.set(false);
            this.step.set('recovery-code');
        } catch {
            this.errorMsg.set('Could not generate a recovery code. Please try again.');
            this.step.set('password');
        }
    }

    /** Writes both wrappings of the master key in one request. */
    private execute(entropy: number[]): void {
        this.step.set('processing');

        from(this.masterKeyService.setupDualWrapped(this.password(), this.recoveryCode(), entropy)).pipe(
            switchMap(dual => this.backupService.putRecoveryKey({
                // `toWrappingDto` carries `publicVerifier` through from the engine. Not optional on
                // this key-establishing write: Echo hard-refuses it without the field. (§L.11)
                ...toWrappingDto(dual.passwordWrapping),
                version: dual.passwordWrapping.version,
                password: this.password(),
                recoveryCodeWrapping: toWrappingDto(dual.recoveryCodeWrapping),
            })),
            tap(() => {
                this.step.set('done');
                // Held only as long as it takes to confirm it; keeping it in memory afterwards
                // serves nothing and it is the one credential a reset cannot replace.
                this.recoveryCode.set('');
                this.confirmation.set('');
                setTimeout(() => this.setupComplete.emit(), 1600);
            }),
            catchError((err: unknown) => {
                // Surfaced, not swallowed. The server's 400 says exactly what is wrong with the
                // envelope, and collapsing every failure into one sentence is why a hard,
                // permanent, every-account refusal was indistinguishable from a flaky network.
                this.errorMsg.set(describeSetupFailure(err));
                this.step.set('password');
                return EMPTY;
            }),
        ).subscribe();
    }
}

/** The most specific thing that can honestly be said about a failed key-establishing write. */
function describeSetupFailure(err: unknown): string {
    console.error('Encryption setup failed', err);

    if (err instanceof MasterKeyEngineError) {
        return `This device could not prepare the keys. ${err.detail}`;
    }
    if (err instanceof HttpErrorResponse) {
        const body = err.error as { detail?: string; title?: string; message?: string } | string | null;
        const served = typeof body === 'string'
            ? body
            : body?.detail ?? body?.message ?? body?.title;
        if (served) return `The server refused the setup: ${served}`;
        return `The server refused the setup (HTTP ${err.status}). Please try again.`;
    }
    return 'Something went wrong. Please try again.';
}
