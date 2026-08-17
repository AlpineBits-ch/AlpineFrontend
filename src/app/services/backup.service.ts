import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {EncryptedMasterKey} from '../dtos/response/UserDto';

/** One wrapping of the master key, as the server stores it. Base64 for the `byte[]` fields. */
export interface MasterKeyWrappingDto {
    kdf: string;
    iterations: number;
    memoryKiB: number;
    parallelism: number;
    salt: string;
    iv: string;
    cipherText: string;
    /**
     * `HKDF-SHA256(masterKey, "", "venta.masterkey.verifier.v1", 32)`, base64. **Contract §L.11.**
     *
     * <p><b>Required on a key-establishing or rotating write</b> - the server refuses one without
     * it, and that refusal is a hard 400 the moment Echo deploys. It was declared here and never
     * populated, so first-time E2EE setup would have failed for every new account with
     * "Something went wrong. Please try again." and no way out of the loop.</p>
     *
     * <p>Optional on the type because the same shape is read back from `GET`, where accounts that
     * predate §L.11 have none. Echo backfills those on the additive same-version path, which is why
     * the retrofit must not rotate: rotation orphans every backup blob.</p>
     */
    publicVerifier?: string | null;
}

export interface PutRecoveryKeyDto extends MasterKeyWrappingDto {
    /** Monotonic. Bumping it orphans every device backup sealed under the previous version. */
    version: number;
    /** Account password - writing this envelope is what makes every backup readable. */
    password: string;
    /**
     * The **same master key** wrapped a second time, under the recovery code.
     *
     * Optional on the wire so a client can upgrade in two steps, but an account without it is one
     * password reset away from losing every backup blob and its account identity key.
     */
    recoveryCodeWrapping?: MasterKeyWrappingDto | null;
}

export interface RecoveryKeyDto extends MasterKeyWrappingDto {
    version: number;
    /** Null when the account never set one up - the state that makes a password reset destructive. */
    recoveryCodeWrapping?: MasterKeyWrappingDto | null;
    /** Set when a password reset invalidated the password wrapping and it has not been re-wrapped. */
    passwordWrappingInvalidatedAt?: string | null;
    /**
     * False when the loss has **already happened**: the password wrapping is stale and there was no
     * recovery-code wrapping to fall back on. Not a warning about the future.
     */
    encryptedHistoryRecoverable: boolean;
}

export interface PutRecoveryKeyResultDto {
    version: number;
    /** Devices whose stored backup the submitted version would make unreadable. */
    orphanedBlobDeviceIds?: string[];
}

/**
 * The account-level backup envelope: the wrapped master key, and the re-wrap repair that a password
 * reset makes necessary.
 *
 * Per-device backup blobs live behind separate routes and are not implemented here yet.
 */
@Injectable({providedIn: 'root'})
export class BackupService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    private get base(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/identity/backup`;
    }

    /**
     * Writes both wrappings of the master key.
     *
     * `acknowledgeOrphans` is required when raising the version would make existing device backups
     * unreadable; the server answers 409 with the affected device ids rather than doing it quietly.
     */
    putRecoveryKey(dto: PutRecoveryKeyDto, acknowledgeOrphans = false): Observable<PutRecoveryKeyResultDto> {
        const query = acknowledgeOrphans ? '?acknowledgeOrphans=true' : '';
        return this.http.put<PutRecoveryKeyResultDto>(`${this.base}/recovery-key${query}`, dto);
    }

    /** The stored envelope, plus whether a reset has left it un-openable. 404 when never set. */
    getRecoveryKey(): Observable<RecoveryKeyDto> {
        return this.http.get<RecoveryKeyDto>(`${this.base}/recovery-key`);
    }

    /**
     * Restores the password wrapping after a reset invalidated it.
     *
     * Deliberately takes no password. The caller has just proved possession of the master key by
     * producing a wrapping of it, and demanding the new password on top would gate the recovery
     * path on the very credential that was reset.
     *
     * The version must match: this re-wraps the existing key rather than rotating it, so every blob
     * already sealed under it stays readable.
     */
    rewrapPassword(
        version: number,
        passwordWrapping: MasterKeyWrappingDto,
    ): Observable<{
        version: number;
        encryptedHistoryRecoverable: boolean;
    }> {
        return this.http.post<{version: number; encryptedHistoryRecoverable: boolean}>(
            `${this.base}/recovery-key/rewrap-password`,
            {version, passwordWrapping},
        );
    }
}

/**
 * Converts a Rust-side wrapping into the shape the server stores.
 *
 * The two disagree on names only - `argon2Iterations` versus `iterations` - and on nothing that
 * changes the bytes.
 */
export function toWrappingDto(key: EncryptedMasterKey): MasterKeyWrappingDto {
    return {
        kdf: 'argon2id',
        iterations: key.argon2Iterations,
        memoryKiB: key.argon2Memory,
        parallelism: key.argon2Parallelism,
        salt: key.salt,
        iv: key.iv,
        cipherText: key.cipherText,
        // Carried through rather than re-derived. It comes from the engine, which is the only place
        // that holds the master key - deriving it here would put those 32 bytes in the host
        // language on a path that otherwise keeps them inside Rust (§L.11).
        publicVerifier: key.publicVerifier ?? null,
    };
}

/** The inverse, for handing a stored wrapping back to Rust to unwrap. */
export function fromWrappingDto(dto: MasterKeyWrappingDto, version: number): EncryptedMasterKey {
    return {
        cipherText: dto.cipherText,
        salt: dto.salt,
        iv: dto.iv,
        argon2Iterations: dto.iterations,
        argon2Memory: dto.memoryKiB,
        argon2Parallelism: dto.parallelism,
        version,
        publicVerifier: dto.publicVerifier ?? null,
    };
}
