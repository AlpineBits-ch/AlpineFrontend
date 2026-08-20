import {computed, inject, Injectable, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {firstValueFrom} from 'rxjs';
import {
    BackupService,
    fromWrappingDto,
    PutRecoveryKeyResultDto,
    RecoveryKeyDto,
    serverRefusalDetail,
    toWrappingDto,
} from './backup.service';
import {CredentialRejectedError, MasterKeyService} from './master-key.service';
import {UserService} from './user.service';

/**
 * How a repair ended, in terms the UI can act on.
 *
 * <p>`credential-rejected` and `engine-failed` are deliberately different outcomes. Collapsing
 * them into one falsy return is exactly what C2 shipped as: `rewrap_master_key` was invoked with
 * three of its five required arguments, so every call failed at Tauri's argument deserialization,
 * and both call sites reported that as "that recovery code did not work". A user mid-recovery,
 * holding a correct code and no other credential, was told the one thing that would make them
 * stop trying.</p>
 */
export type MasterKeyRepair =
    /** Done. `recoveryCode` is set on a retrofit, and must be shown exactly once. */
    | {outcome: 'ok'; recoveryCode?: string}
    /** The credential genuinely does not open the wrapping. The only "check your code" case. */
    | {outcome: 'credential-rejected'}
    /** Nothing to repair from - no envelope, or no recovery-code wrapping to unwrap. */
    | {outcome: 'not-applicable'}
    /** The server answered 200 and stored nothing. Never show a code the server does not hold. */
    | {outcome: 'not-stored'}
    /** The local engine could not run the operation. Not the user's credential, and not their fault. */
    | {outcome: 'engine-failed'; detail: string};

/**
 * How a re-key ended. A superset of {@link MasterKeyRepair}, because two of its outcomes only exist
 * for an operation that abandons the key the account already has.
 */
export type MasterKeyReset =
    | MasterKeyRepair
    /** Nothing was written. These devices' stored backups die with the old key. Ask, then retry. */
    | {outcome: 'orphans-pending'; deviceIds: string[]}
    /** The server refused the write and said why. Neither a local fault nor a wrong credential. */
    | {outcome: 'server-refused'; detail: string};

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
 * The account master key's health, the two repairs it can need, and the re-key it cannot avoid when
 * neither repair is open.
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
    private readonly user = inject(UserService);

    private readonly _envelope = signal<RecoveryKeyDto | null>(null);
    private readonly _action = signal<MasterKeyAction>('ok');

    readonly action = this._action.asReadonly();
    readonly envelope = this._envelope.asReadonly();

    /** True when the user must act before backups mean anything. */
    readonly needsAttention = computed(() => {
        const action = this._action();
        return (
            action === 'rewrap-required' || action === 'unrecoverable' || action === 'recovery-code-missing'
        );
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
            if ((err as {status?: number})?.status === 404) {
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
     * <p>The recovery code is normalized by the engine, the new password never is - which is why
     * both kinds are named explicitly rather than inferred from the shape of the string.</p>
     */
    async rewrapUnderNewPassword(recoveryCode: string, newPassword: string): Promise<MasterKeyRepair> {
        const envelope = this._envelope();
        if (!envelope?.recoveryCodeWrapping) return {outcome: 'not-applicable'};

        let rewrapped;
        try {
            rewrapped = await this.masterKey.rewrap(
                fromWrappingDto(envelope.recoveryCodeWrapping, envelope.version),
                recoveryCode,
                'recoveryCode',
                newPassword,
                'password',
            );
        } catch (err) {
            // Only a genuine credential rejection is reported as one. Anything else is the engine
            // failing to run, and telling someone their last surviving credential is wrong when it
            // is not is the worst answer available here.
            if (err instanceof CredentialRejectedError) return {outcome: 'credential-rejected'};
            return {outcome: 'engine-failed', detail: (err as Error)?.message ?? String(err)};
        }

        // The version must match: this re-wraps the key the account already has, and writing a
        // different one would orphan every blob sealed under the current version.
        await firstValueFrom(this.backup.rewrapPassword(envelope.version, toWrappingDto(rewrapped)));
        await this.refresh();
        return {outcome: 'ok'};
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
     * @returns `ok` with the code to show the user once; never a code the server did not store.
     */
    async addRecoveryCode(password: string): Promise<MasterKeyRepair> {
        const envelope = this._envelope();
        if (!envelope) return {outcome: 'not-applicable'};

        const code = await this.masterKey.generateRecoveryCode();

        let recoveryWrapping;
        try {
            recoveryWrapping = await this.masterKey.rewrap(
                fromWrappingDto(envelope, envelope.version),
                password,
                'password',
                code,
                'recoveryCode',
            );
        } catch (err) {
            if (err instanceof CredentialRejectedError) return {outcome: 'credential-rejected'};
            return {outcome: 'engine-failed', detail: (err as Error)?.message ?? String(err)};
        }

        await firstValueFrom(
            this.backup.putRecoveryKey({
                // The password wrapping is re-sent unchanged: the endpoint writes the pair, and sending
                // half of it would drop the wrapping that still works. Byte-identical too - a fresh IV
                // would change the ciphertext and earn a 400 at the same version.
                kdf: envelope.kdf,
                iterations: envelope.iterations,
                memoryKiB: envelope.memoryKiB,
                parallelism: envelope.parallelism,
                salt: envelope.salt,
                iv: envelope.iv,
                cipherText: envelope.cipherText,
                // §L.11: the two wrappings of one key must carry the *same* verifier, and Echo rejects
                // a mismatch. The stored password wrapping predates the field on every existing
                // account, so the value the engine just derived is sent for both halves - it is derived
                // from the master key alone, so it is correct for the wrapping already on the server.
                publicVerifier: recoveryWrapping.publicVerifier ?? envelope.publicVerifier ?? null,
                version: envelope.version,
                password,
                recoveryCodeWrapping: toWrappingDto(recoveryWrapping),
            }),
        );

        // Verified, not assumed. A 200 here does not prove the second wrapping was stored - the
        // endpoint treats a same-version write as an idempotent re-post and returns Ok having
        // written nothing, which would leave the user holding a code that opens nothing while
        // being told they are protected. Re-read and check before showing it to them.
        await this.refresh();
        if (!this._envelope()?.recoveryCodeWrapping) return {outcome: 'not-stored'};

        return {outcome: 'ok', recoveryCode: code};
    }

    /**
     * Abandons the master key and writes a fresh one. **Everything sealed under the old key is
     * lost.**
     *
     * <p>The way out of `rewrap-required` for a user who no longer has their recovery code, and out
     * of `unrecoverable` for one whose key is already beyond reach. Neither state has a credential
     * left that opens the old key, so there is nothing to re-wrap: the account either gets a new key
     * or stays stuck. Only a caller that has told the user what they are giving up may call this.</p>
     *
     * <p>The version is raised, which is what makes it a rotation rather than the additive write
     * {@link addRecoveryCode} performs. The server refuses the first attempt with the devices whose
     * stored backups the rotation would strand; pass `acknowledgeOrphans` once the user has seen
     * them.</p>
     *
     * @returns `ok` with the new code to show exactly once.
     */
    async resetEncryption(password: string, acknowledgeOrphans = false): Promise<MasterKeyReset> {
        const envelope = this._envelope();
        if (!envelope) return {outcome: 'not-applicable'};

        // Checked here rather than left to the server's 400: that refusal arrives as prose, and this
        // is the one operation where "incorrect password" must not be guessed at from a message that
        // also carries every envelope-shaped rejection.
        if (!(await firstValueFrom(this.user.verifyPassword(password)))) {
            return {outcome: 'credential-rejected'};
        }

        // A second attempt after an orphan warning mints a new key and a new code rather than
        // holding the first pair. Nothing was written, so nothing depends on them, and keeping a
        // wrapped key alive in a service field across a user decision buys only a way to get it out
        // of step with the code on screen.
        const code = await this.masterKey.generateRecoveryCode();

        let dual;
        try {
            dual = await this.masterKey.setupDualWrapped(password, code);
        } catch (err) {
            return {outcome: 'engine-failed', detail: (err as Error)?.message ?? String(err)};
        }

        try {
            await firstValueFrom(
                this.backup.putRecoveryKey(
                    {
                        ...toWrappingDto(dual.passwordWrapping),
                        // Not the engine's version. This key replaces the account's, and the server
                        // reads anything but a bump as a claim that the bytes seal the same key.
                        version: envelope.version + 1,
                        password,
                        recoveryCodeWrapping: toWrappingDto(dual.recoveryCodeWrapping),
                    },
                    acknowledgeOrphans,
                ),
            );
        } catch (err) {
            if (err instanceof HttpErrorResponse && err.status === 409) {
                const body = err.error as PutRecoveryKeyResultDto | null;
                return {outcome: 'orphans-pending', deviceIds: body?.orphanedBlobDeviceIds ?? []};
            }
            const refusal = serverRefusalDetail(err);
            if (refusal) return {outcome: 'server-refused', detail: refusal};
            return {outcome: 'engine-failed', detail: (err as Error)?.message ?? String(err)};
        }

        // Same rule as the retrofit: a code is shown only once the server is known to hold the
        // wrapping it opens. Here the version is the tell - an envelope still at the old one means
        // the rotation did not take, and the code on screen would open nothing.
        await this.refresh();
        const written = this._envelope();
        if (!written?.recoveryCodeWrapping || written.version <= envelope.version) {
            return {outcome: 'not-stored'};
        }

        return {outcome: 'ok', recoveryCode: code};
    }
}
