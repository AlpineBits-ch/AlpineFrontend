import {MlsEngine} from '../ports/mls-engine.port';
import {IdbStore, IdbStoreClosedError, openStore} from './idb';
import {
    dispatchVentaCrypto,
    loadVentaCrypto,
    VentaCryptoLoader,
    VentaCryptoModule,
} from './venta-crypto';

/**
 * The commands that change durable engine state, and therefore the ones the web adapter has to
 * persist after.
 *
 * <p><b>Derived from `mls.rs`, not from the names.</b> The discriminator is whether the engine
 * function calls `MlsState::save_to_disk` - which on the desktop is what makes the operation durable
 * and on wasm is a no-op - and it does not line up with the Rust borrow: `generate_key_packages_with_handle`
 * takes `&MlsState` and still persists, because openmls' provider store mutates through `&self`. So
 * `&mut` is not the signal and neither is the verb in the name; the `save_to_disk` call site is.</p>
 *
 * <p>The four commands that look mutating and are not: `mls_load_signing_key` and
 * `mls_unload_signing_key` touch only the session signer map, which `to_persisted` deliberately
 * excludes (the keypair lives in {@link SecureStore}, not in the engine store), and `mls_export_state`
 * / `mls_export_backup` only read. `mls_clear_storage` is mutating but is <b>not</b> in this set: it is
 * handled separately, because the desktop equivalent deletes the state file rather than writing one -
 * see {@link WebMlsEngine.clearStoredState}.</p>
 */
export const MLS_MUTATING_COMMANDS: ReadonlySet<string> = new Set([
    'generate_mls_key_packages',
    'mls_generate_key_packages_with_handle',
    'mls_create_group',
    'mls_add_members',
    'mls_remove_members',
    'mls_join_group',
    'mls_leave_group',
    'mls_commit_pending_proposals',
    'mls_merge_pending_commit',
    'mls_clear_pending_commit',
    'mls_rejoin_group',
    'mls_delete_group',
    'mls_send_message',
    'mls_process_message',
    'mls_drain_pending_messages',
    'mls_import_state',
    'mls_import_backup',
]);

/** Its own database, for the reason `WebSecureStore` gives: a shared name means a shared upgrade. */
const DB_NAME = 'alpine-mls-state';
const STORE_NAME = 'state';

/**
 * The engine state could not be made durable, so the operation that produced it must not be reported
 * as having happened.
 *
 * <p>Latched rather than one-off - see {@link WebMlsEngine} - because the failure leaves memory ahead
 * of storage, and the only thing that repairs that is a reload.</p>
 */
export class MlsStateNotPersistedError extends Error {
    constructor(readonly command: string, readonly detail: string) {
        super(
            `The MLS engine performed ${command} but this browser could not save the result, so the `
            + `operation has been refused rather than reported as done. Reload the page to return to `
            + `the last saved state. (${detail})`,
        );
        this.name = 'MlsStateNotPersistedError';
    }
}

/** The stored state exists but could not be read, so nothing may be written over it. */
export class MlsStateUnreadableError extends Error {
    constructor(readonly detail: string) {
        super(
            `This browser holds saved MLS state but could not read it, so no group operation will be `
            + `attempted - writing over it would destroy the only copy of this device's group keys. `
            + `Reload the page. (${detail})`,
        );
        this.name = 'MlsStateUnreadableError';
    }
}

/**
 * {@link MlsEngine} over the `venta-crypto` WASM module, with the persistence the desktop gets for
 * free.
 *
 * <p><b>This adapter exists mostly to close one divergence.</b> `MlsState::save_to_disk` is a no-op on
 * `wasm32`, so every engine operation that "persists" succeeds here without writing anything. Native,
 * that call is what makes a group join, a merged commit or an advanced ratchet survive a restart.
 * Without the export below, a user's membership, ratchet state and message history would vanish on
 * refresh with nothing anywhere reporting it - so after every command in
 * {@link MLS_MUTATING_COMMANDS} this adapter calls `mls_export_state` and writes the sealed blob to
 * IndexedDB, and on `mls_init_storage` it reads it back through `mls_import_state`. Same encrypted
 * format the desktop writes, same key: no new at-rest format.</p>
 *
 * <h3>Atomicity: memory ahead of storage is a latched refusal, never a silent success</h3>
 *
 * <p>The engine has already mutated by the time the export runs, so a failed write leaves in-memory
 * state ahead of durable state. Three things happen, in this order:</p>
 * <ol>
 *   <li>The originating call <b>rejects</b> with {@link MlsStateNotPersistedError}. It is safe to
 *       report a failure for work the engine did do, because every published artefact - a commit, a
 *       welcome, a ciphertext - is published by the caller <i>after</i> `call` resolves. A rejection
 *       means nothing left this machine, and a reload rolls the engine back to the last durable blob,
 *       so the group never sees the operation at all.</li>
 *   <li>The fault is <b>latched</b>, and every later mutating command rejects with it. Continuing
 *       would pile more unpersisted work onto an engine that is already diverged, and a mixture of
 *       persisted and unpersisted operations is the one state a reload cannot repair.</li>
 *   <li>Reads keep working. They cannot deepen the divergence, and refusing them too would take the
 *       UI that has to explain this down with it.</li>
 * </ol>
 *
 * <p>The mirror-image hazard is handled the same way. If the stored blob is <i>unreadable</i> - not
 * absent, unreadable - then restoring is impossible and overwriting is unrecoverable, so
 * {@link MlsStateUnreadableError} latches before a single mutation is allowed. Note what this
 * deliberately does <b>not</b> do: it does not throw out of `mls_init_storage`, because
 * `MainPageComponent.runDeviceLaunch` treats any `initStorage` rejection as a corrupt state file and
 * wipes local MLS state - which for a transient IndexedDB fault would destroy the very blob it could
 * not read. A blob that is genuinely present-but-broken is a different case and does propagate, which
 * is exactly what the desktop does with a corrupt `mls_state_{scope}.json`.</p>
 *
 * <h3>Account scope</h3>
 *
 * <p>The blob is keyed by the `scope` argument `mls_init_storage` already carries - the per-account
 * device id - so two accounts in one browser profile never read each other's engine state. That is
 * the only account isolation on this host, because the wasm `mls_init_storage` cannot clear the engine
 * on a scope change the way the native one does (there is no path to compare). It is sufficient only
 * because switching accounts on the web is a full document load; see the note in `wasm.rs`.</p>
 */
export class WebMlsEngine extends MlsEngine {
    /**
     * Whether this host has a working MLS engine.
     *
     * <p><b>False means "loading it failed", not "it has not finished loading".</b> The module is part
     * of the deployment, so until a load has actually failed the honest answer is yes - and reading
     * the in-flight window as unavailable would be actively harmful: `MlsService.readRegistry`
     * answers `null` when the engine is unavailable, `null` means "this context was never encrypted
     * here", and a message composed against that answer during the first second of a boot would go
     * out in cleartext into a conversation this device has encrypted. That is the §L.9 downgrade the
     * encryption floor exists to refuse.</p>
     *
     * <p>A failed load flips it false and keeps it false until a later load succeeds, so a broken or
     * blocked wasm fetch is reported rather than retried into silence. The load is started by the
     * constructor, so the window in which this is optimistic is the shortest one available.</p>
     */
    available = true;

    private readonly load: VentaCryptoLoader;
    private readonly open: () => Promise<IdbStore>;

    private module: Promise<VentaCryptoModule> | undefined;
    private store: Promise<IdbStore> | undefined;

    /** Set by a successful `mls_init_storage`. Without it nothing can be sealed, so nothing is. */
    private stateKeyB64: string | undefined;
    private scope: string | undefined;

    /** The latched durability fault, if any. See the class comment. */
    private fault: Error | undefined;

    /**
     * @param load  the wasm module loader. Injectable so a spec can drive a fake engine.
     * @param open  opens the blob store. Injectable so a spec can hand in a `fake-indexeddb` factory.
     */
    constructor(
        load: VentaCryptoLoader = loadVentaCrypto,
        open: () => Promise<IdbStore> = () => openStore(DB_NAME, STORE_NAME),
    ) {
        super();
        this.load = load;
        this.open = open;
        // Started now, not on first call, so `available` has a real answer as early as possible. The
        // rejection is swallowed here and re-raised by `call`, which is the caller that can act on it.
        void this.wasm().catch(() => undefined);
    }

    /** Resolves once the engine is usable, or rejects with why it is not. For boot and for specs. */
    async ready(): Promise<void> {
        await this.wasm();
    }

    async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        const mutating = MLS_MUTATING_COMMANDS.has(command);
        if (this.fault && (mutating || command === 'mls_clear_storage')) throw this.fault;

        const module = await this.wasm();

        if (command === 'mls_init_storage') return await this.initStorage(module, args) as T;
        if (command === 'mls_clear_storage') return await this.clearStorage<T>(module);

        const result = dispatchVentaCrypto<T>(module, command, args);
        if (mutating) await this.persist(module, command);
        return result;
    }

    /**
     * `mls_init_storage`, plus the restore the desktop gets from its state file.
     *
     * <p>The wasm command itself only validates: it requires the state key and always answers `false`,
     * because there is no file to have found. The restore is this method's job, and its `true` is what
     * makes `MlsService.initStorage`'s documented contract - "true when state was restored" - mean the
     * same thing on both hosts.</p>
     */
    private async initStorage(
        module: VentaCryptoModule,
        args?: Record<string, unknown>,
    ): Promise<boolean> {
        // First, and unguarded: a missing state key is refused by Rust with the native error string
        // verbatim, and that classification must not be pre-empted by anything here.
        dispatchVentaCrypto<boolean>(module, 'mls_init_storage', args);

        const stateKeyB64 = typeof args?.['stateKeyB64'] === 'string' ? args['stateKeyB64'] : undefined;
        const scope = typeof args?.['scope'] === 'string' ? args['scope'] : undefined;
        if (!stateKeyB64) return false;

        this.stateKeyB64 = stateKeyB64;
        this.scope = scope;

        let stored: string | undefined;
        try {
            stored = await this.read(this.blobKey());
        } catch (err) {
            // Latched, and deliberately not thrown - see the class comment. Nothing may overwrite or
            // delete a blob this adapter has failed to read.
            this.fault = new MlsStateUnreadableError(describe(err));
            return false;
        }

        if (stored === undefined) return false;

        // A failure here is a blob that is present and broken, which is the desktop's corrupt-state-file
        // case. Propagated so the launch sequence takes the same recovery it takes there.
        dispatchVentaCrypto<void>(module, 'mls_import_state', {
            encryptedB64: stored,
            encryptionKeyB64: stateKeyB64,
        });
        return true;
    }

    /**
     * `mls_clear_storage`, plus the deletion the desktop's `std::fs::remove_file` performs.
     *
     * <p>Engine first, then the blob, matching the order everywhere else here: a delete that landed
     * before a failed engine call would leave storage behind memory, which on the next reload reads as
     * an unrequested wipe. A failed delete latches, because a wipe that did not wipe leaves this
     * account's key material recoverable by whoever uses the browser next.</p>
     */
    private async clearStorage<T>(module: VentaCryptoModule): Promise<T> {
        const result = dispatchVentaCrypto<T>(module, 'mls_clear_storage');
        try {
            await this.remove(this.blobKey());
        } catch (err) {
            this.fault = new MlsStateNotPersistedError('mls_clear_storage', describe(err));
            throw this.fault;
        }
        return result;
    }

    /** Seals the whole provider store and writes it. The web's entire equivalent of an autosave. */
    private async persist(module: VentaCryptoModule, command: string): Promise<void> {
        if (!this.stateKeyB64) {
            // The same situation native reports from `save_to_disk` with no `state_path`, in the same
            // words: the operation ran and cannot be persisted. Refused rather than dropped silently,
            // which is the bug that version of `save_to_disk` was changed away from.
            //
            // Deliberately *not* latched, unlike a failed write. This is a caller-ordering fault rather
            // than a diverged store, and a later `mls_init_storage` resolves it by construction -
            // `mls_import_state` clears the engine before restoring, so whatever this operation left in
            // memory is replaced rather than merged. Latching would brick the page for a fault that
            // fixes itself.
            throw new Error(
                'MlsError: MLS storage is not initialised - initStorage must succeed before any group '
                + 'operation, or the operation is silently lost',
            );
        }

        try {
            const blob = dispatchVentaCrypto<string>(module, 'mls_export_state', {
                encryptionKeyB64: this.stateKeyB64,
            });
            await this.write(this.blobKey(), blob);
        } catch (err) {
            this.fault = new MlsStateNotPersistedError(command, describe(err));
            throw this.fault;
        }
    }

    /**
     * The blob's key, namespaced by account.
     *
     * <p>An un-scoped init - no `scope` argument at all - gets its own name rather than silently
     * sharing one with an account's, because a shared name is how two accounts came to hold one
     * `mls_state.json` on the desktop.</p>
     */
    private blobKey(): string {
        return `state::${this.scope ?? 'unscoped'}`;
    }

    private async read(key: string): Promise<string | undefined> {
        const value = await this.withStore(store => store.get(key));
        if (value === undefined) return undefined;
        if (typeof value !== 'string') {
            // `mls_export_state` returns base64, so anything else under this key was written by
            // something else. Handing it to `mls_import_state` would report a corrupt engine state.
            throw new Error(`"${DB_NAME}"/"${STORE_NAME}" key "${key}" does not hold a state blob`);
        }
        return value;
    }

    private async write(key: string, blob: string): Promise<void> {
        await this.withStore(store => store.set(key, blob));
    }

    private async remove(key: string): Promise<void> {
        await this.withStore(store => store.delete(key));
    }

    /**
     * Runs one store operation, reopening once if another tab's upgrade closed the connection.
     *
     * <p>Exactly the retry `WebSecureStore` documents, for the same reason and with the same limit:
     * every operation here is an idempotent get, put or delete, and anything other than a closed
     * connection - `quota`, `unavailable` - is answered honestly on the first attempt rather than
     * delayed.</p>
     */
    private async withStore<T>(op: (store: IdbStore) => Promise<T>): Promise<T> {
        try {
            return await op(await this.blobStore());
        } catch (err) {
            if (!(err instanceof IdbStoreClosedError)) throw err;
            this.store = undefined;
            return await op(await this.blobStore());
        }
    }

    private blobStore(): Promise<IdbStore> {
        this.store ??= this.open().catch((err: unknown) => {
            this.store = undefined;
            throw err;
        });
        return this.store;
    }

    private wasm(): Promise<VentaCryptoModule> {
        this.module ??= this.load().then(
            module => {
                this.available = true;
                return module;
            },
            (err: unknown) => {
                // Reported through `available` *and* by rejecting every call: the port's own comment
                // is that an engine which failed to load must refuse loudly rather than report
                // success for operations that never happened.
                this.available = false;
                this.module = undefined;
                throw err;
            },
        );
        return this.module;
    }
}

function describe(err: unknown): string {
    return typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
}
