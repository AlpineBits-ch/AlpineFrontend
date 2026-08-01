import {Component, EventEmitter, inject, Input, Output, signal} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PasswordDirective} from 'primeng/password';
import {EntropyModalComponent} from '../entropy-modal/entropy-modal.component';
import {UserService} from '../../../services/user.service';
import {MasterKeyService} from '../../../services/master-key.service';
import {BackupService, toWrappingDto} from '../../../services/backup.service';
import {PlatformService} from '../../../services/platform.service';
import {AppInfoService} from '../../../services/app-info.service';
import {catchError, EMPTY, filter, from, switchMap, take, tap} from 'rxjs';
import {TranslateModule} from '@ngx-translate/core';

/**
 * `recovery-code` and `confirm-code` sit between entropy collection and the upload deliberately.
 *
 * The recovery code is the only credential that survives a password reset, so it has to exist
 * *before* the master key is written - and the user must have confirmed it before proceeding,
 * because a code nobody wrote down is the same as no code at all. Contract §C.1.1 also puts the
 * "losing both is unrecoverable" statement on that screen rather than in a help article, which is
 * why it is a blocking step and not a dismissible notice.
 */
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
    @Output() setupComplete = new EventEmitter<void>();

    protected step = signal<Step>('password');
    protected password = signal('');
    protected errorMsg = signal('');
    /** Shown once, on the `recovery-code` step, and never retrievable afterwards. */
    protected recoveryCode = signal('');
    /** What the user types back on `confirm-code`. */
    protected confirmation = signal('');
    protected copied = signal(false);

    protected readonly appInfo = inject(AppInfoService);
    private userService = inject(UserService);
    private masterKeyService = inject(MasterKeyService);
    private backupService = inject(BackupService);
    private platformService = inject(PlatformService);
    /** Entropy collected before the recovery-code steps, carried through to the upload. */
    private collectedEntropy: number[] = [];

    private readonly showEntropy =
        !this.platformService.isMobile &&
        window.matchMedia('(pointer: fine)').matches;

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

    /**
     * Checks the retyped code before anything is generated.
     *
     * Compared with formatting and case folded away, matching what the KDF does with it - otherwise
     * a user who typed their code correctly but without the hyphens would be told it was wrong.
     */
    protected onConfirmCode(): void {
        if (normalizeCode(this.confirmation()) !== normalizeCode(this.recoveryCode())) {
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

    /**
     * Writes both wrappings of the master key in one request.
     *
     * Through `PUT /backup/recovery-key` rather than `POST /users/master`, because that is the only
     * route that stores the recovery-code wrapping - and an account that has just been told it has
     * a recovery code, but whose second wrapping never reached the server, is in the worst possible
     * state: it believes it is protected against a password reset and is not.
     */
    private execute(entropy: number[]): void {
        this.step.set('processing');

        from(this.masterKeyService.setupDualWrapped(this.password(), this.recoveryCode(), entropy)).pipe(
            switchMap(dual => this.backupService.putRecoveryKey({
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
            catchError(() => {
                this.errorMsg.set('Something went wrong. Please try again.');
                this.step.set('password');
                return EMPTY;
            }),
        ).subscribe();
    }
}

/** Folds grouping, whitespace and case, mirroring what the Rust side does before the KDF. */
function normalizeCode(input: string): string {
    return input.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}
