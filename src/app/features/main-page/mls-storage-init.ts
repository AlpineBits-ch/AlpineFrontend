/**
 * Whether a failed `initStorage` is allowed to cost this device its groups.
 *
 * <p><b>The bug this file exists to close.</b> `MainPageComponent.runDeviceLaunch` used to treat
 * <i>any</i> `initStorage` rejection as a corrupt state file and wipe local MLS state. But that call
 * fails for reasons that have nothing to do with the state file: the state key could not be read out
 * of the OS keychain, the credential service had not started yet, IndexedDB was momentarily
 * unavailable on the web host, `std::fs::read` returned a permission error, the wasm engine had not
 * loaded. In every one of those the state file is <i>fine</i> and the keys are recoverable - and the
 * wipe destroyed them, taking every message in every group this device belongs to with them. A
 * transient fault became permanent, irreversible data loss.</p>
 *
 * <h3>Why this matches on strings</h3>
 *
 * <p>Because the string <i>is</i> the contract that crosses the Rust/TypeScript boundary. Both hosts
 * reject with a plain string: Tauri's `invoke` rejects with the command's `Err(String)`, and
 * wasm-bindgen throws the `JsValue::from_str` verbatim. There is no error class, no code and no
 * `kind` to discriminate on, and the engine's own source says in as many words that the wording is
 * load bearing for this decision (`crates/venta-crypto/src/mls.rs`, `init_storage_from_parts`;
 * `crates/venta-crypto/src/wasm.rs`, `mls_init_storage`, whose refusal is copied from the native one
 * rather than paraphrased for exactly this reason).</p>
 *
 * <p>So the matching is centralised here and pinned by `mls-storage-init.spec.ts`, which reads the
 * Rust sources off disk and asserts every literal below still appears in them. Reword an engine
 * error and a TypeScript test fails, which is the point: the alternative is a reworded error
 * silently reclassifying as "corrupt" and going back to wiping people's keys.</p>
 *
 * <h3>Unknown is transient, deliberately</h3>
 *
 * <p>The default for an unrecognised message is <b>do not wipe</b>. The two mistakes are not
 * comparable: classifying corruption as transient leaves the user with a retry banner and their
 * sealed state still on disk, which any later launch or a better classifier can fix; classifying a
 * keychain hiccup as corruption deletes the only copy of their group keys, which nothing can fix.
 * Where the costs are that asymmetric the default belongs on the recoverable side.</p>
 *
 * <p>It is also the empirically common case. The single most likely transient failure on the desktop
 * - `SecureStore.getItem` throwing while reading the state key, before the engine is even called -
 * produces an OS keychain message that matches none of the engine's wording at all. Under a
 * "default to corrupt" rule that path alone wipes.</p>
 */

// ---------------------------------------------------------------------------
// The engine's own wording. Verbatim, and pinned by the spec beside this file.
// ---------------------------------------------------------------------------

/**
 * No state key was available this launch, so the engine refused to initialise.
 *
 * <p>Verbatim from `init_storage_from_parts` in `crates/venta-crypto/src/mls.rs`, and from its
 * `#[cfg(target_arch = "wasm32")]` twin `mls_init_storage` in `crates/venta-crypto/src/wasm.rs`,
 * which copies rather than paraphrases it. That deliberate agreement is what lets one classifier
 * serve both hosts.</p>
 *
 * <p><b>Nothing has been read or written when this is returned.</b> It is raised before the state
 * path is touched, so the state file is untouched by definition - which is why it can never justify
 * a wipe.</p>
 */
export const MLS_NO_STATE_KEY_ERROR =
    'MlsError: no state key was supplied - mls_state.json cannot be written unsealed, so '
    + 'encryption stays unavailable until the keychain produces one';

/**
 * A sealed state file was found and the key that opens it was not supplied.
 *
 * <p>From the same function, further down. Unreachable in practice today - the refusal above returns
 * first - but it is the clearer statement of the same event, and if the ordering there ever changes
 * this is the message that arrives. Classified transient: a sealed file plus a missing keychain
 * entry is the exact situation in which wiping is worst.</p>
 */
export const MLS_SEALED_NO_STATE_KEY_ERROR =
    'MlsError: mls_state.json is sealed but no state key was supplied - the keychain entry '
    + 'that opens it is missing';

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
 * AES-GCM authentication failed.
 *
 * <p><b>The weakest link in this contract, and named as such.</b> `decrypt_blob` maps the aead error
 * through `e.to_string()`, and `aead::Error`'s `Display` is that bare literal - so this is the
 * `aes-gcm` crate's wording, not the engine's. It is matched anyway because on the web host it is the
 * <i>only</i> signal that the stored blob is present and undecryptable: the wasm path restores through
 * `mls_import_state`, which has no message of its own. A crate upgrade that reworded it would fail
 * the spec beside this file, and until it was fixed corrupt web state would classify as transient -
 * the safe direction.</p>
 */
export const MLS_AEAD_FAILURE_ERROR = 'aead::Error';

/**
 * The web adapter found something under its blob key that it never wrote.
 *
 * <p>From `WebMlsEngine.read`. Present-but-malformed, so it belongs with the corrupt cases: handing
 * it to `mls_import_state` is what the adapter is refusing to do.</p>
 */
export const MLS_NOT_A_STATE_BLOB_ERROR = 'does not hold a state blob';

/**
 * Substrings that mean "the state key was not available", i.e. nothing was read and nothing is wrong
 * with the stored state.
 *
 * <p>Shortened to the invariant rather than the whole sentence, on the same reasoning the Rust test
 * `writing_state_without_a_key_is_refused` gives for matching `"without a state key"`: the refusal is
 * shared with venta-mobile verbatim, and a phrase unique to one client's prose would break the next
 * time the two are re-synced. The full sentences are pinned separately, by the spec, against the Rust
 * source - so a reword is still caught, it just surfaces as "the contract moved" instead of as a
 * silent reclassification.</p>
 */
export const MLS_STATE_KEY_UNAVAILABLE_MARKERS: readonly string[] = [
    'no state key was supplied',
];

/**
 * Substrings that mean "the stored state is present and cannot be read", the one case that may wipe.
 *
 * <p>Every entry here has to be a statement about the <i>stored bytes</i>. A message about the
 * keychain, the filesystem, the network or the engine failing to load must never be added, because
 * membership of this list is the licence to delete a user's only copy of their group keys.</p>
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
    /**
     * The state key could not be produced this launch - a locked keychain, a credential service that
     * has not started, an IndexedDB fault on web. Recoverable by retrying; the stored state is
     * untouched.
     */
    | 'state-key-unavailable'
    /**
     * Stored state exists and could not be decrypted or parsed. The desktop's corrupt
     * `mls_state_{scope}.json` case, and the only one a wipe is a valid answer to.
     */
    | 'state-unreadable'
    /**
     * Something else. Treated as transient - see the file comment for why the asymmetry in cost
     * decides this, and why this is the bucket the most likely real-world fault lands in.
     */
    | 'unknown';

export interface MlsStorageFault {
    kind: MlsStorageFaultKind;
    /**
     * Whether local MLS state may be destroyed in response. True for `state-unreadable` and for
     * nothing else.
     *
     * <p>Carried as its own field rather than left for each caller to derive from {@link kind},
     * because a caller that has to write the condition itself is a caller that can write it wrong -
     * which is the bug this module exists to close.</p>
     */
    mayWipe: boolean;
    /** Whether offering a plain retry is honest. The inverse of {@link mayWipe} today. */
    retryable: boolean;
    /** The message the classification was read from, for the log. */
    message: string;
}

/**
 * Reads an `initStorage` rejection as one of {@link MlsStorageFaultKind}.
 *
 * <p>Transient is tested first and the order is load bearing: {@link MLS_SEALED_NO_STATE_KEY_ERROR}
 * talks about a sealed state file <i>and</i> a missing key, and it must land on the key.</p>
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
 * The text to classify from, for every shape an engine rejection arrives in.
 *
 * <p>Both hosts reject with a plain string, so that is the case that matters; `Error` covers the
 * adapters' own failures and `{message}` covers `MlsTypedError`. Case is preserved - `aead::Error`
 * is matched as written.</p>
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

/**
 * Initialises MLS storage, wiping only what may be wiped.
 *
 * <p>A plain function over its steps for the reason `runMlsLaunch` is one: the defect is entirely
 * about control flow, and while it lived inside a component nothing could construct without half the
 * application, nothing tested it.</p>
 */
export async function runMlsStorageInit(
    steps: MlsStorageInitSteps,
): Promise<MlsStorageInitOutcome> {
    let restored: boolean;
    try {
        restored = await steps.initStorage();
    } catch (err: unknown) {
        const fault = classifyMlsStorageFault(err);
        // The whole point. Anything that is not "the stored state is present and unreadable" keeps
        // its state and gets a retry, because the state is still there to be read next time.
        if (!fault.mayWipe) return {restored: false, wiped: false, fault};

        await steps.wipe();
        return {restored: false, wiped: true, fault};
    }
    return {restored, wiped: false, fault: null};
}
