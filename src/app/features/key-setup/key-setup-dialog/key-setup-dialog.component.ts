import {Component, EventEmitter, inject, Input, Output, signal} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PasswordDirective} from 'primeng/password';
import {EntropyModalComponent} from '../entropy-modal/entropy-modal.component';
import {HttpErrorResponse} from '@angular/common/http';
import {UserService} from '../../../services/user.service';
import {MasterKeyEngineError, MasterKeyService} from '../../../services/master-key.service';
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
    /**
     * Whether the user may back out.
     *
     * <p>False at launch, where the account asked for the messaging half and setup is the price of
     * entry. True when `SocialKeyGateService` raised this in front of a single action - there,
     * refusing has to be free, or the gate is just the launch dialog wearing a different hat.</p>
     *
     * <p>The way out is offered on the `password` step only, and see {@link dismiss} for why.</p>
     */
    @Input() dismissible = false;
    @Output() setupComplete = new EventEmitter<void>();
    @Output() dismissed = new EventEmitter<void>();

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

    /**
     * Backs out of a deferred prompt, leaving nothing behind.
     *
     * <p>Only reachable from the `password` step, deliberately. Past it a recovery code has been
     * generated and shown, and the account is told it holds one; quitting between that screen and
     * the write leaves a user who has carefully written down a code the server never stored, which
     * they discover at the exact moment it was supposed to save them.</p>
     */
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

    /**
     * Checks the retyped code before anything is generated.
     *
     * <p>Folded through the **engine's** normaliser, not a local one. This used to call a private
     * `normalizeCode()` that stripped non-alphanumerics and upper-cased and validated neither the
     * length nor the alphabet - a second, weaker copy of rules that decide which key gets derived.
     * Two copies drift, and the drift surfaces as a correct code being called wrong, or as a
     * subtly different key. `normalize_recovery_code_checked` exists precisely so TypeScript need
     * not keep one.</p>
     */
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
                // `toWrappingDto` carries `publicVerifier` through from the engine. It is not
                // optional on this write: this is the key-establishing one, and Echo hard-refuses
                // it without the field. Nothing derived it before, so first-time E2EE setup would
                // have 400'd for every new account the moment the server deployed - and the
                // `catchError` below turned that into "Something went wrong. Please try again.",
                // which is an unbreakable loop rather than an error. (§L.11)
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

/**
 * The most specific thing that can honestly be said about a failed key-establishing write.
 *
 * Prefers the server's own message: `PUT /backup/recovery-key` refuses a first write with no
 * `publicVerifier`, a mismatched pair of verifiers, or a cipherText that differs at an unchanged
 * version - all of them client bugs, all of them actionable, and none of them survivable as
 * "please try again".
 */
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
