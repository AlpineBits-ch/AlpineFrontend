import {inject, Injectable} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {firstValueFrom, take} from 'rxjs';
import {UserService} from './user.service';
import {MasterKeyEngineError, MasterKeyService} from './master-key.service';
import {BackupService, PutRecoveryKeyResultDto, serverRefusalDetail, toWrappingDto} from './backup.service';

/**
 * Whether asking again could plausibly work.
 *
 * A 4xx about envelope shape is deterministic for that account, and a device that cannot prepare
 * keys will not start being able to. Everything else, including an unrecognised failure, counts as
 * retryable: offering a retry that fails again is cheaper than refusing one that would have worked.
 */
export function isRetryableFailure(err: unknown): boolean {
    if (err instanceof MasterKeyEngineError) return false;
    if (err instanceof HttpErrorResponse) return err.status < 400 || err.status >= 500;
    return true;
}

/**
 * First-time master-key setup: generate a recovery code, wrap the key under both credentials,
 * write the envelope.
 *
 * The recovery code is held here rather than by a caller. It is shown once, is never retrievable,
 * and an account that loses it loses everything a password reset touches, so the window it exists
 * in belongs to the thing that mints it.
 */
@Injectable({providedIn: 'root'})
export class MasterKeySetupService {
    private readonly users = inject(UserService);
    private readonly masterKeys = inject(MasterKeyService);
    private readonly backups = inject(BackupService);

    private recoveryCode = '';

    verifyPassword(password: string): Promise<boolean> {
        return firstValueFrom(this.users.verifyPassword(password).pipe(take(1)));
    }

    /** Mints the code, holds it for the rest of this setup, and returns it to be shown once. */
    async generateRecoveryCode(): Promise<string> {
        this.discard();
        this.recoveryCode = await this.masterKeys.generateRecoveryCode();
        return this.recoveryCode;
    }

    /**
     * Wraps the master key under the password and the held recovery code, then writes both.
     *
     * @throws MasterKeyEngineError from the engine, or an `HttpErrorResponse` from the write. Put
     *         either through {@link describeFailure}.
     */
    async run(password: string, userEntropy: number[] = []): Promise<PutRecoveryKeyResultDto> {
        if (!this.recoveryCode) {
            throw new Error('No recovery code held. Generate one before running setup.');
        }

        const dual = await this.masterKeys.setupDualWrapped(password, this.recoveryCode, userEntropy);
        const result = await firstValueFrom(
            this.backups.putRecoveryKey({
                // `toWrappingDto` carries `publicVerifier` through from the engine. Echo hard-refuses
                // this key-establishing write without it (§L.11).
                ...toWrappingDto(dual.passwordWrapping),
                version: dual.passwordWrapping.version,
                password,
                recoveryCodeWrapping: toWrappingDto(dual.recoveryCodeWrapping),
            }),
        );

        // The one credential a reset cannot replace. Nothing may reuse it once the write landed.
        this.recoveryCode = '';
        return result;
    }

    /**
     * What went wrong with a key-establishing write, or null when nothing more than "it failed"
     * can honestly be said.
     *
     * The server's 400 names the problem with the envelope. Collapsing every failure into one
     * sentence is what made a hard, permanent, every-account refusal look like a flaky network.
     */
    describeFailure(err: unknown): string | null {
        console.error('Encryption setup failed', err);

        if (err instanceof MasterKeyEngineError) {
            return `This device could not prepare the keys. ${err.detail}`;
        }
        const refusal = serverRefusalDetail(err);
        if (refusal) return `The server refused the setup: ${refusal}`;
        return null;
    }

    /** Drops the held code, for a setup that was abandoned rather than finished. */
    discard(): void {
        this.recoveryCode = '';
    }
}
