import {inject, Injectable, Injector} from '@angular/core';
import {CryptoEngine} from '../platform/ports/crypto-engine.port';
import {EncryptedMasterKey} from '../dtos/response/UserDto';

/** Both wrappings of one master key, produced together so they provably seal the same bytes. */
export interface DualWrappedMasterKey {
    passwordWrapping: EncryptedMasterKey;
    recoveryCodeWrapping: EncryptedMasterKey;
}

/**
 * Which credential a side of a re-wrap is, so normalisation is never guessed.
 *
 * <p>The engine used to infer this from the shape of the string, which is how a recovery code
 * containing a symbol this client did not know silently derived the wrong key. The caller always
 * knows which it holds; the wire values match Rust's `CredentialKind`.</p>
 */
export type CredentialKind = 'password' | 'recoveryCode';

/**
 * The credential genuinely did not open the wrapping, or is not a well-formed recovery code.
 *
 * The only condition under which a user may be told their password or recovery code is wrong.
 */
export class CredentialRejectedError extends Error {
    constructor(readonly kind: CredentialKind, readonly detail: string) {
        super(`The ${kind === 'password' ? 'password' : 'recovery code'} did not open the wrapping.`);
    }
}

/**
 * The command never ran - bad arguments, an absent command, no engine.
 *
 * <p><b>Kept strictly separate from {@link CredentialRejectedError}, and that separation is the
 * point.</b> `rewrap_master_key` was invoked with three of its five required arguments, so every
 * call failed at Tauri's argument deserialization before any crypto ran - and both callers caught
 * the rejection bare and reported it as a bad credential. A user mid-recovery, holding a correct
 * recovery code and nothing else, was told their only surviving credential was wrong. An
 * infrastructure fault must never be rendered as a credential rejection, in either direction.</p>
 */
export class MasterKeyEngineError extends Error {
    constructor(readonly command: string, readonly detail: string) {
        super(`The local key engine could not run ${command}: ${detail}`);
    }
}

/**
 * Whether an engine rejection is genuinely about the credential the user supplied.
 *
 * <p>An allow-list, and it fails to the safe side on purpose: anything unrecognised is an engine
 * fault, because "we could not run the check" must not be shown as "your code is wrong". The
 * reverse default is what C2 shipped as.</p>
 */
function isCredentialRejection(err: unknown): boolean {
    const text = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
    return text.includes('Decryption failed')
        || text.startsWith('InvalidRecoveryCode')
        || text.includes('Unwrapped master key is not 32 bytes');
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
    private readonly injector = inject(Injector);

    /**
     * The engine behind every method here. Same Rust code on both hosts - IPC on the desktop,
     * wasm-bindgen in a browser - so a master key wrapped on one unwraps on the other.
     *
     * <p>That parity is asserted, not assumed: `parity_tests.rs` opens venta-mobile's golden wrappings
     * on native and on `wasm32`, and the Argon2 parameters are part of the at-rest format and are
     * identical by construction because it is one implementation.</p>
     *
     * <p>Resolved on demand rather than injected as a field, for the reason `DeviceIdentityService`
     * documents: `SocialKeyGateService` holds this service and is read by components all over the app -
     * `InviteDialogComponent` among them - almost none of which ever ask it for a key. As a field it
     * made <i>constructing</i> those components require a `CryptoEngine` provider, which failed eight
     * invite-dialog tests on a path that never touches crypto.</p>
     */
    private get engine(): CryptoEngine {
        return this.injector.get(CryptoEngine);
    }

    /**
     * Whether this build can do any of the below at all.
     *
     * <p><b>Now true everywhere.</b> It used to be `isTauri()`, because every method here was a Tauri
     * command and outside Tauri each of them rejected before a single byte of crypto happened -
     * {@link generateRecoveryCode} included, which is the first irreversible step of setup and the one
     * that made the whole ceremony unfinishable in a browser. The `venta-crypto` WASM crate removes
     * that: the browser runs the same engine, so the ceremony completes and its output is openable by
     * the desktop.</p>
     *
     * <p>Kept as a method rather than deleted, because its callers' judgement is still the right one to
     * express and the answer could change again for a third host. `SocialKeyGateService` fails <i>open</i>
     * on false - it must never show a ceremony that cannot be finished - and `true` here is what now
     * makes it show the ceremony to web users, which is the point of the port.</p>
     *
     * <p>There is deliberately no `available` flag on {@link CryptoEngine} to forward to: an engine that
     * cannot generate keys is a boot failure rather than a capability to branch on, so a load failure
     * rejects per call instead of being reported here as "this platform does not do keys".</p>
     */
    isAvailable(): boolean {
        return true;
    }

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
        return this.engine.call<DualWrappedMasterKey>('setup_master_key_dual', {
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
        return this.engine.call<string>('generate_recovery_code');
    }

    /**
     * Unwraps with one credential and re-wraps under another, without the key crossing IPC.
     *
     * <p>The password-reset repair: unwrap from the recovery code, re-wrap under the new password.
     * The master key is unchanged, so every blob sealed under it stays readable - which is exactly
     * why this re-wraps rather than re-keying.</p>
     *
     * <p><b>Both kinds are explicit, and neither may be inferred.</b> The engine normalises a
     * recovery code and leaves a password exactly as typed, and it cannot tell which it has been
     * handed. An earlier version normalized only the `from` side, so the retrofit sealed the new
     * wrapping under a *dashed* code that no later unwrap could reproduce - the user was handed a
     * code that opened nothing and told they were protected. The Rust signature was fixed; these
     * two arguments were never plumbed through, so every call failed at argument deserialization
     * instead.</p>
     *
     * @throws CredentialRejectedError when `fromCredential` does not open `encrypted`.
     * @throws MasterKeyEngineError when the command itself could not run. Never surface this as a
     *         rejected credential.
     */
    async rewrap(
        encrypted: EncryptedMasterKey,
        fromCredential: string,
        fromKind: CredentialKind,
        toCredential: string,
        toKind: CredentialKind,
    ): Promise<EncryptedMasterKey> {
        try {
            return await this.engine.call<EncryptedMasterKey>('rewrap_master_key', {
                encrypted,
                fromCredential,
                fromKind,
                toCredential,
                toKind,
            });
        } catch (err) {
            throw classify(err, 'rewrap_master_key', fromKind);
        }
    }

    /**
     * Folds a typed recovery code to the form the KDF consumes, or explains why it is not one.
     *
     * <p>Routed to the engine rather than reimplemented here. A second copy of the alphabet and
     * the grouping rules in TypeScript is a copy that can drift from the one that actually derives
     * the key, and the drift shows up as "that code isn't valid" against a correct code - or,
     * worse, as a silently different key.</p>
     *
     * @throws CredentialRejectedError when the code is not well formed.
     */
    async normalizeRecoveryCode(code: string): Promise<string> {
        try {
            return await this.engine.call<string>('normalize_recovery_code_checked', {code});
        } catch (err) {
            throw classify(err, 'normalize_recovery_code_checked', 'recoveryCode');
        }
    }

    /**
     * @deprecated Prefer {@link setupDualWrapped}. A single password-derived wrapping leaves the
     * account one password reset away from losing everything it protects.
     */
    async setupMasterKey(password: string, userEntropy: number[] = []): Promise<EncryptedMasterKey> {
        return this.engine.call<EncryptedMasterKey>('setup_master_key', {password, userEntropy});
    }

    /**
     * Unwraps the master key with `credential`, used **exactly as given**.
     *
     * <p><b>Nothing is normalized here, and the caller must not assume otherwise.</b> An earlier
     * version of this comment claimed a recovery code was recognised and folded; the engine
     * explicitly does the opposite, and is right to - guessing whether a string is a password or a
     * recovery code derives the wrong key silently in whichever direction it guesses wrong, and
     * reports it as a wrong credential. Only the caller knows which it holds.</p>
     *
     * <p>Pass a password verbatim; put a recovery code through {@link normalizeRecoveryCode}
     * first.</p>
     *
     * @throws CredentialRejectedError when the credential does not open the envelope.
     * @throws MasterKeyEngineError when the command could not run.
     */
    async decryptMasterKey(
        encrypted: EncryptedMasterKey,
        credential: string,
        kind: CredentialKind = 'password',
    ): Promise<Uint8Array> {
        try {
            const bytes = await this.engine.call<number[]>('decrypt_master_key', {
                encrypted,
                password: credential,
            });
            return new Uint8Array(bytes);
        } catch (err) {
            throw classify(err, 'decrypt_master_key', kind);
        }
    }
}

function classify(err: unknown, command: string, kind: CredentialKind): Error {
    const detail = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
    return isCredentialRejection(err)
        ? new CredentialRejectedError(kind, detail)
        : new MasterKeyEngineError(command, detail);
}
