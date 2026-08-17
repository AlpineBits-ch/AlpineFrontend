/**
 * Whether a failed `initStorage` is allowed to cost this device its groups. Classification matches
 * on strings because the string is the whole contract across the Rust/TypeScript boundary; every
 * literal below is pinned by `mls-storage-init.spec.ts` against the Rust sources. An unrecognised
 * message must default to NOT wiping: misreading a keychain hiccup as corruption destroys the only
 * copy of the keys, while the reverse merely leaves the state on disk.
 */

// ---------------------------------------------------------------------------
// The engine's own wording. Verbatim, and pinned by the spec beside this file.
// ---------------------------------------------------------------------------

/**
 * No state key was available this launch, so the engine refused to initialise. Verbatim from
 * `init_storage_from_parts` in `crates/venta-crypto/src/mls.rs` and its wasm twin. Raised before the
 * state path is touched, so it can never justify a wipe.
 */
export const MLS_NO_STATE_KEY_ERROR =
    'MlsError: no state key was supplied - mls_state.json cannot be written unsealed, so ' +
    'encryption stays unavailable until the keychain produces one';

/**
 * A sealed state file was found and the key that opens it was not supplied. Classified transient: a
 * sealed file plus a missing keychain entry is the situation in which wiping is worst.
 */
export const MLS_SEALED_NO_STATE_KEY_ERROR =
    'MlsError: mls_state.json is sealed but no state key was supplied - the keychain entry ' +
    'that opens it is missing';

/** The sealed state file did not authenticate under this device's state key. Native. */
export const MLS_STATE_DID_NOT_OPEN_ERROR =
    "MlsError: mls_state.json did not open with this device's state key";

/** A group is named in the state file and its data is not in the provider store. Native. */
export const MLS_GROUP_DATA_MISSING_ERROR =
    'is listed in state but its data is missing from storage - state may be corrupted';

/** A group's stored data was present and openmls refused to load it. Native. */
export const MLS_GROUP_LOAD_FAILED_ERROR = 'MlsError: failed to load group';

/** The sealed blob is shorter than a nonce, so there is nothing to decrypt. `decrypt_blob`. */
export const MLS_BLOB_TOO_SHORT_ERROR = 'MlsError: encrypted blob too short';

/**
 * AES-GCM authentication failed. This is the `aes-gcm` crate's wording, not the engine's, so it is
 * the weakest literal here; on the web host it is the only signal that a stored blob is present and
 * undecryptable. A crate reword fails the spec beside this file and classifies transient until fixed.
 */
export const MLS_AEAD_FAILURE_ERROR = 'aead::Error';

/** The web adapter found something under its blob key that it never wrote. Present but malformed. */
export const MLS_NOT_A_STATE_BLOB_ERROR = 'does not hold a state blob';

/**
 * Substrings meaning "the state key was not available": nothing was read, and nothing is wrong with
 * the stored state. Shortened to the invariant rather than the whole sentence, which venta-mobile
 * shares verbatim; the full sentences are pinned separately by the spec.
 */
export const MLS_STATE_KEY_UNAVAILABLE_MARKERS: readonly string[] = ['no state key was supplied'];

/**
 * Substrings meaning "the stored state is present and cannot be read", the one case that may wipe.
 * Every entry must be a statement about the stored bytes. Never add a keychain, filesystem, network
 * or engine-load message: membership of this list is the licence to delete the user's group keys.
 */
export const MLS_STATE_UNREADABLE_MARKERS: readonly string[] = [
    "did not open with this device's state key",
    'is listed in state but its data is missing from storage',
    'failed to load group',
    'encrypted blob too short',
    MLS_AEAD_FAILURE_ERROR,
    'does not hold a state blob',
];

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type MlsStorageFaultKind =
    /** The state key could not be produced this launch. Retryable; the stored state is untouched. */
    | 'state-key-unavailable'
    /** Stored state exists and could not be decrypted or parsed. The only kind a wipe answers. */
    | 'state-unreadable'
    /** Something else. Treated as transient. */
    | 'unknown';

export interface MlsStorageFault {
    kind: MlsStorageFaultKind;
    /** Whether local MLS state may be destroyed. True for `state-unreadable` and nothing else. */
    mayWipe: boolean;
    /** Whether offering a plain retry is honest. The inverse of {@link mayWipe} today. */
    retryable: boolean;
    /** The message the classification was read from, for the log. */
    message: string;
}

/**
 * Reads an `initStorage` rejection as one of {@link MlsStorageFaultKind}. Transient is tested first
 * and the order is load bearing: {@link MLS_SEALED_NO_STATE_KEY_ERROR} names a sealed state file and
 * a missing key, and it must land on the key.
 */
export function classifyMlsStorageFault(err: unknown): MlsStorageFault {
    const message = describeMlsStorageError(err);

    if (MLS_STATE_KEY_UNAVAILABLE_MARKERS.some(m => message.includes(m))) {
        return {kind: 'state-key-unavailable', mayWipe: false, retryable: true, message};
    }
    if (MLS_STATE_UNREADABLE_MARKERS.some(m => message.includes(m))) {
        return {kind: 'state-unreadable', mayWipe: true, retryable: false, message};
    }
    return {kind: 'unknown', mayWipe: false, retryable: true, message};
}

/**
 * The text to classify from, for every shape an engine rejection arrives in. Case is preserved:
 * `aead::Error` is matched as written.
 */
function describeMlsStorageError(err: unknown): string {
    if (typeof err === 'string') return err;
    if (err instanceof Error) return err.message;
    const message = (err as {message?: unknown} | null)?.message;
    return typeof message === 'string' ? message : String(err);
}

// ---------------------------------------------------------------------------
// The launch step
// ---------------------------------------------------------------------------

/** The steps, injected so the wipe decision can be exercised without an Angular anything. */
export interface MlsStorageInitSteps {
    /** `MlsService.initStorage()`. Resolves true when stored state was restored. */
    initStorage: () => Promise<boolean>;
    /** Deletes the local engine state and resets the server's key packages. Corrupt path only. */
    wipe: () => Promise<void>;
}

export interface MlsStorageInitOutcome {
    /** Whether previously stored state was restored. Meaningless unless {@link fault} is null. */
    restored: boolean;
    /** Whether {@link MlsStorageInitSteps.wipe} was called. */
    wiped: boolean;
    /** Why the init failed, or null when it did not. */
    fault: MlsStorageFault | null;
}

/** Initialises MLS storage, wiping only what may be wiped. */
export async function runMlsStorageInit(steps: MlsStorageInitSteps): Promise<MlsStorageInitOutcome> {
    let restored: boolean;
    try {
        restored = await steps.initStorage();
    } catch (err: unknown) {
        const fault = classifyMlsStorageFault(err);
        // Anything that is not "present and unreadable" keeps its state and gets a retry.
        if (!fault.mayWipe) return {restored: false, wiped: false, fault};

        await steps.wipe();
        return {restored: false, wiped: true, fault};
    }
    return {restored, wiped: false, fault: null};
}
