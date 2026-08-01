import {computed, inject, Injectable, signal} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {BackupService, fromWrappingDto, RecoveryKeyDto, toWrappingDto} from './backup.service';
import {MasterKeyService} from './master-key.service';

/** What, if anything, the account needs the user to do about its master key. */
export type MasterKeyAction =
    /** Nothing. Both wrappings present and current. */
    | 'ok'
    /** A password reset invalidated the password wrapping. Re-wrap from the recovery code. */
    | 'rewrap-required'
    /** No recovery-code wrapping yet. One password reset from `unrecoverable`. */
    | 'recovery-code-missing'
    /**
     * Already lost. A reset happened with no recovery-code wrapping to fall back on, so the master
     * key can no longer be derived by anyone and every backup blob sealed under it is gone.
     */
    | 'unrecoverable'
    /** The account has no master key at all - first-run setup, not a problem state. */
    | 'not-set-up';

/**
 * The account master key's health, and the two repairs it can need.
 *
 * <p>Split from {@link MasterKeyService}, which does the cryptography, because this is entirely
 * about *state the user has to be told about*. Contract §C.1.1 exists because the previous
 * behaviour was silent: a password reset left the master key sealed under a forgotten password, and
 * the account carried on looking healthy until the first restore attempt failed - by which point
 * nothing could be done.</p>
 */
@Injectable({providedIn: 'root'})
export class MasterKeyStateService {
    private readonly backup = inject(BackupService);
    private readonly masterKey = inject(MasterKeyService);

    private readonly _envelope = signal<RecoveryKeyDto | null>(null);
    private readonly _action = signal<MasterKeyAction>('ok');

    readonly action = this._action.asReadonly();
    readonly envelope = this._envelope.asReadonly();

    /** True when the user must act before backups mean anything. */
    readonly needsAttention = computed(() => {
        const action = this._action();
        return action === 'rewrap-required' || action === 'unrecoverable'
            || action === 'recovery-code-missing';
    });

    /**
     * Cloud engine-state backup and `VerifiedDevices` both require the second wrapping; the server
     * refuses them without it. Surfaced here so the UI can explain *why* rather than showing a
     * disabled control with no reason.
     */
    readonly canUseCloudEngineBackup = computed(() => this._action() === 'ok');

    /** Reads the account's envelope and works out what it needs. Call on unlock. */
    async refresh(): Promise<MasterKeyAction> {
        let envelope: RecoveryKeyDto;
        try {
            envelope = await firstValueFrom(this.backup.getRecoveryKey());
        } catch (err: unknown) {
            // 404 is "never set up", which is first-run rather than a fault. Anything else leaves
            // the previous verdict standing: guessing 'ok' on a failed lookup is how a real loss
            // goes unreported.
            if ((err as { status?: number })?.status === 404) {
                this._envelope.set(null);
                this._action.set('not-set-up');
                return 'not-set-up';
            }
            return this._action();
        }

        this._envelope.set(envelope);

        // Order matters: an already-completed loss is not a prompt to do something, it is news.
        const action: MasterKeyAction = !envelope.encryptedHistoryRecoverable
            ? 'unrecoverable'
            : envelope.passwordWrappingInvalidatedAt
                ? 'rewrap-required'
                : envelope.recoveryCodeWrapping
                    ? 'ok'
                    : 'recovery-code-missing';

        this._action.set(action);
        return action;
    }

    /**
     * Restores the password wrapping after a reset, using the recovery code.
     *
     * The master key is unwrapped from the recovery-code wrapping and re-wrapped under the new
     * password - same key, so every blob sealed under it stays readable. Re-keying instead would
     * "fix" the login and destroy the history it was supposed to protect.
     *
     * @returns false when the recovery code does not open the wrapping.
     */
    async rewrapUnderNewPassword(recoveryCode: string, newPassword: string): Promise<boolean> {
        const envelope = this._envelope();
        if (!envelope?.recoveryCodeWrapping) return false;

        let rewrapped;
        try {
            rewrapped = await this.masterKey.rewrap(
                fromWrappingDto(envelope.recoveryCodeWrapping, envelope.version),
                recoveryCode,
                newPassword,
            );
        } catch {
            return false;
        }

        // The version must match: this re-wraps the key the account already has, and writing a
        // different one would orphan every blob sealed under the current version.
        await firstValueFrom(this.backup.rewrapPassword(envelope.version, toWrappingDto(rewrapped)));
        await this.refresh();
        return true;
    }

    /**
     * Adds the missing recovery-code wrapping to an account that only has the password one.
     *
     * <p>Retrofit for accounts created before dual wrapping. The master key is unwrapped with the
     * password and re-wrapped under a fresh code; both wrappings are then written together, because
     * they have to describe the same key at the same version.</p>
     *
     * <p><b>The version is deliberately not bumped.</b> This adds a second wrapping of the key the
     * account already has - nothing is re-keyed, so nothing is orphaned. Raising the version would
     * invalidate every device backup blob sealed under the current one, which is the opposite of
     * what a user asking for more safety expects.</p>
     *
     * @returns the code to show the user once, or null when the password was wrong or the wrapping
     *          did not actually reach the server.
     */
    async addRecoveryCode(password: string): Promise<string | null> {
        const envelope = this._envelope();
        if (!envelope) return null;

        const code = await this.masterKey.generateRecoveryCode();

        let recoveryWrapping;
        try {
            recoveryWrapping = await this.masterKey.rewrap(
                fromWrappingDto(envelope, envelope.version),
                password,
                code,
            );
        } catch {
            return null;
        }

        await firstValueFrom(this.backup.putRecoveryKey({
            // The password wrapping is re-sent unchanged: the endpoint writes the pair, and sending
            // half of it would drop the wrapping that still works.
            kdf: envelope.kdf,
            iterations: envelope.iterations,
            memoryKiB: envelope.memoryKiB,
            parallelism: envelope.parallelism,
            salt: envelope.salt,
            iv: envelope.iv,
            cipherText: envelope.cipherText,
            version: envelope.version,
            password,
            recoveryCodeWrapping: toWrappingDto(recoveryWrapping),
        }));

        // Verified, not assumed. A 200 here does not prove the second wrapping was stored - the
        // endpoint treats a same-version write as an idempotent re-post and returns Ok having
        // written nothing, which would leave the user holding a code that opens nothing while
        // being told they are protected. Re-read and check before showing it to them.
        await this.refresh();
        if (!this._envelope()?.recoveryCodeWrapping) return null;

        return code;
    }
}
