import {Injectable} from '@angular/core';
import {invoke} from '@tauri-apps/api/core';
import {EncryptedMasterKey} from '../dtos/response/UserDto';

/** Both wrappings of one master key, produced together so they provably seal the same bytes. */
export interface DualWrappedMasterKey {
    passwordWrapping: EncryptedMasterKey;
    recoveryCodeWrapping: EncryptedMasterKey;
}

/**
 * The account master key: 32 random bytes that every backup blob and the account identity key are
 * ultimately sealed under.
 *
 * <p><b>It is wrapped twice</b> - under a key derived from the account password, and under a key
 * derived from a recovery code. That is not belt-and-braces. With only the password wrapping, a
 * password reset leaves the envelope sealed under a key derived from a password the user has, by
 * definition of a reset, forgotten: every backup and the account identity key become permanently
 * unopenable, silently, at the exact moment the user is trying to recover their account.</p>
 *
 * <p>The key is generated inside Rust and never crosses IPC during setup or re-wrapping.
 * {@link decryptMasterKey} does return it, because callers need it to seal exports.</p>
 */
@Injectable({providedIn: 'root'})
export class MasterKeyService {
    /**
     * Generates the master key and wraps it under both credentials in one call.
     *
     * One call rather than two, so the two wrappings cannot end up sealing different keys - a
     * mistake that looks fine until the day the recovery path is actually needed, and cannot be
     * repaired then.
     */
    async setupDualWrapped(
        password: string,
        recoveryCode: string,
        userEntropy: number[] = [],
    ): Promise<DualWrappedMasterKey> {
        return invoke<DualWrappedMasterKey>('setup_master_key_dual', {
            password,
            recoveryCode,
            userEntropy,
        });
    }

    /**
     * A fresh recovery code, in groups of four.
     *
     * Drawn from an alphabet with no `0`/`O` or `1`/`I`/`L`: it is transcribed by hand and used
     * exactly once, after a password reset, which is the worst imaginable moment to discover an
     * ambiguous character.
     */
    async generateRecoveryCode(): Promise<string> {
        return invoke<string>('generate_recovery_code');
    }

    /**
     * Unwraps with one credential and re-wraps under another, without the key crossing IPC.
     *
     * The password-reset repair: unwrap from the recovery code, re-wrap under the new password. The
     * master key is unchanged, so every blob sealed under it stays readable - which is exactly why
     * this re-wraps rather than re-keying.
     */
    async rewrap(
        encrypted: EncryptedMasterKey,
        fromCredential: string,
        toCredential: string,
    ): Promise<EncryptedMasterKey> {
        return invoke<EncryptedMasterKey>('rewrap_master_key', {
            encrypted,
            fromCredential,
            toCredential,
        });
    }

    /**
     * @deprecated Prefer {@link setupDualWrapped}. A single password-derived wrapping leaves the
     * account one password reset away from losing everything it protects.
     */
    async setupMasterKey(password: string, userEntropy: number[] = []): Promise<EncryptedMasterKey> {
        return invoke<EncryptedMasterKey>('setup_master_key', {password, userEntropy});
    }

    /**
     * Unwraps the master key. `credential` is either the account password or the recovery code -
     * a recovery code is recognised and normalized, a password is used exactly as given.
     */
    async decryptMasterKey(encrypted: EncryptedMasterKey, credential: string): Promise<Uint8Array> {
        const bytes = await invoke<number[]>('decrypt_master_key', {
            encrypted,
            password: credential,
        });
        return new Uint8Array(bytes);
    }
}
