import {MlsSessionTakeover} from '../mls-session';
import {MlsEngine} from '../ports/mls-engine.port';
import {IdbStore, IdbStoreClosedError, openStore} from './idb';
import {
    SessionClaim,
    SessionLock,
    SessionLockFactory,
    sessionLockName,
    SessionState,
    WebLocksSessionLock,
} from './session-lock';
import {dispatchVentaCrypto, loadVentaCrypto, VentaCryptoLoader, VentaCryptoModule} from './venta-crypto';

/** The commands that change durable engine state, and so must be persisted after. */
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
 */
export class MlsStateNotPersistedError extends Error {
    constructor(
        readonly command: string,
        readonly detail: string,
    ) {
        super(
            `The MLS engine performed ${command} but this browser could not save the result, so the ` +
                `operation has been refused rather than reported as done. Reload the page to return to ` +
                `the last saved state. (${detail})`,
        );
        this.name = 'MlsStateNotPersistedError';
    }
}

/**
 * Another tab of this browser profile owns this account's engine, so this one may not touch it.
 * The message must contain none of "not found", "unknown command", "not allowed" or any
 * `MLS_STATE_UNREADABLE_MARKERS`, or a classifier misreads the refusal.
 */
export class MlsSessionHeldElsewhereError extends Error {
    constructor(readonly command: string) {
        super(
            `Venta is open in another tab of this browser, and that tab owns this account's encryption ` +
                `engine, so ${command} was refused here. Two live engines for one device reuse ` +
                `sender-ratchet generations and overwrite each other's group state, which destroys group ` +
                `keys silently. Use the other tab, or close it - this one takes the engine over by ` +
                `itself once it does.`,
        );
        this.name = 'MlsSessionHeldElsewhereError';
    }
}

/**
 * This browser has no Web Locks API, so single-tab ownership cannot be established at all.
 * Same message wording constraints as {@link MlsSessionHeldElsewhereError}.
 */
export class MlsSessionGuardUnavailableError extends Error {
    constructor(readonly command: string) {
        super(
            `This browser cannot guarantee that only one tab uses this account's encryption engine - it ` +
                `has no Web Locks API, which means either an insecure origin or a browser older than ` +
                `Chrome 69 / Firefox 96 / Safari 15.4 - so ${command} was refused. Two tabs sharing one ` +
                `engine destroy group keys with nothing reporting it, so this refuses rather than risk ` +
                `it. Open Venta over https in a current browser.`,
        );
        this.name = 'MlsSessionGuardUnavailableError';
    }
}

/** The stored state exists but could not be read, so nothing may be written over it. */
export class MlsStateUnreadableError extends Error {
    constructor(readonly detail: string) {
        super(
            `This browser holds saved MLS state but could not read it, so no group operation will be ` +
                `attempted - writing over it would destroy the only copy of this device's group keys. ` +
                `Reload the page. (${detail})`,
        );
        this.name = 'MlsStateUnreadableError';
    }
}

/**
 * {@link MlsEngine} over the `venta-crypto` WASM module, with the persistence the desktop gets for
 * free. One tab per scope, enforced by an exclusive {@link SessionLock}.
 */
export class WebMlsEngine extends MlsEngine implements MlsSessionTakeover {
    /** Whether this host has a working MLS engine. False means the load failed, not "still loading". */
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

    private readonly newLock: SessionLockFactory;

    /** Ownership of the current scope. Replaced, not mutated, when the scope changes. */
    private lease: SessionLock | undefined;

    /** A restore that was skipped because another tab owned the scope. Cleared by the takeover. */
    private restoreDeferred = false;

    /** Told when a scope this tab was refused is granted to it. See {@link onSessionTakeover}. */
    private readonly takeoverListeners = new Set<() => void>();

    /**
     * @param load  the wasm module loader. Injectable so a spec can drive a fake engine.
     * @param open  opens the blob store. Injectable so a spec can hand in a `fake-indexeddb` factory.
     * @param newLock  builds the per-scope session lock. Injectable because jsdom has no
     *     `navigator.locks`, and because two "tabs" in one spec have to share one lock manager for the
     *     guard to be provable at all.
     */
    constructor(
        load: VentaCryptoLoader = loadVentaCrypto,
        open: () => Promise<IdbStore> = () => openStore(DB_NAME, STORE_NAME),
        newLock: SessionLockFactory = name => new WebLocksSessionLock(name),
    ) {
        super();
        this.load = load;
        this.open = open;
        this.newLock = newLock;
        // Started now, not on first call, so `available` has a real answer as early as possible.
        void this.wasm().catch(() => undefined);
    }

    /** Resolves once the engine is usable, or rejects with why it is not. For boot and for specs. */
    async ready(): Promise<void> {
        await this.wasm();
    }

    /** Whether this tab owns the engine for the current scope, without attempting to take it. */
    sessionState(): SessionState {
        return this.lease?.state ?? 'unclaimed';
    }

    /**
     * Registers a listener for the moment this tab is handed a scope it was refused. The engine is
     * not restored yet when this fires; {@link requireSession} restores on the next command.
     *
     * @returns a function that stops the listener being called. Registering the same function twice
     *     registers it once, and the returned function removes it either way.
     */
    onSessionTakeover(listener: () => void): () => void {
        this.takeoverListeners.add(listener);
        return () => this.takeoverListeners.delete(listener);
    }

    async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        const mutating = MLS_MUTATING_COMMANDS.has(command);
        if (this.fault && (mutating || command === 'mls_clear_storage')) throw this.fault;

        const module = await this.wasm();

        if (command === 'mls_init_storage') return (await this.initStorage(module, args)) as T;
        // Must stay ahead of `requireSession`: a delete is the one write a tab without the lock may perform.
        if (command === 'mls_clear_storage') return await this.clearStorage<T>(module);

        await this.requireSession(module, command);

        const result = dispatchVentaCrypto<T>(module, command, args);
        if (mutating) await this.persist(module, command);
        return result;
    }

    /** Ownership of the current scope, or the refusal that says why not. */
    private async requireSession(module: VentaCryptoModule, command: string): Promise<void> {
        const claim = await this.session().claim();
        if (claim !== 'held') throw refusal(claim, command);
        if (!this.restoreDeferred) return;

        // Must restore before this command runs, so nothing runs against an engine behind storage.
        this.restoreDeferred = false;
        const stateKeyB64 = this.stateKeyB64;
        // No init has succeeded, so there is nothing to restore against and nothing to seal with.
        if (stateKeyB64 === undefined) return;

        await this.restore(module, stateKeyB64);
        // An unreadable blob latches rather than throwing inside `restore`, so surface it here.
        if (this.fault) throw this.fault;
    }

    /** The lock for the scope this adapter is currently working in, `unscoped` until init supplies one. */
    private session(): SessionLock {
        const name = sessionLockName(this.scope);
        if (this.lease !== undefined && this.lease.name !== name) {
            this.lease.release();
            this.lease = undefined;
        }
        if (this.lease === undefined) {
            const lease = this.newLock(name);
            // Must register on creation: the grant arrives on the lock's own queued request, and there
            // is no later point at which this adapter could subscribe.
            lease.onGranted(() => this.announceTakeover());
            this.lease = lease;
        }
        return this.lease;
    }

    /** Tells the listeners this tab now owns the scope. One that throws must not stop the next. */
    private announceTakeover(): void {
        for (const listener of [...this.takeoverListeners]) {
            try {
                listener();
            } catch (err) {
                console.error('An MLS session-takeover listener threw', err);
            }
        }
    }

    /**
     * `mls_init_storage`, plus the restore the desktop gets from its state file. A tab that does not
     * win the scope must resolve `false` rather than reject, or the boot path wipes local MLS state.
     */
    private async initStorage(module: VentaCryptoModule, args?: Record<string, unknown>): Promise<boolean> {
        // Must run first and unguarded, so Rust's native error string is not pre-empted.
        dispatchVentaCrypto<boolean>(module, 'mls_init_storage', args);

        const stateKeyB64 = typeof args?.['stateKeyB64'] === 'string' ? args['stateKeyB64'] : undefined;
        const scope = typeof args?.['scope'] === 'string' ? args['scope'] : undefined;
        if (!stateKeyB64) return false;

        this.stateKeyB64 = stateKeyB64;
        this.scope = scope;

        const claim = await this.session().claim();
        if (claim !== 'held') {
            // Nothing is read or written; the restore is owed to a later grant of the lock.
            this.restoreDeferred = true;
            // TODO(i18n): surface this in the UI instead of the console. The locales are a git submodule
            //  and need their own commit, so the keys are proposed here rather than added:
            //    mls.session.otherTab.title  - "Venta is already open in another tab"
            //    mls.session.otherTab.body   - "Only one tab can use this account's encryption at a
            //                                   time. Close the other tab and this one takes over."
            //    mls.session.unguarded.title - "This browser cannot run Venta safely"
            //    mls.session.unguarded.body  - "Venta needs the Web Locks API to be sure only one tab
            //                                   uses your encryption keys. Open Venta over https in a
            //                                   current browser."
            console.warn(refusal(claim, 'mls_init_storage').message);
            return false;
        }

        this.restoreDeferred = false;
        return await this.restore(module, stateKeyB64);
    }

    /**
     * Reads the sealed blob back into the engine. The web's whole equivalent of reading a state file.
     *
     * @returns true when state was restored, false when there was none to restore or it could not be
     *     read. The second case latches {@link MlsStateUnreadableError} rather than throwing.
     */
    private async restore(module: VentaCryptoModule, stateKeyB64: string): Promise<boolean> {
        let stored: string | undefined;
        try {
            stored = await this.read(this.blobKey());
        } catch (err) {
            // Latched, not thrown: nothing may overwrite a blob this adapter has failed to read.
            this.fault = new MlsStateUnreadableError(describe(err));
            return false;
        }

        if (stored === undefined) return false;

        // A present-but-broken blob propagates, matching the desktop's corrupt-state-file case.
        dispatchVentaCrypto<void>(module, 'mls_import_state', {
            encryptedB64: stored,
            encryptionKeyB64: stateKeyB64,
        });
        return true;
    }

    /**
     * `mls_clear_storage`, plus the deletion the desktop's `std::fs::remove_file` performs. Engine
     * first, then the blob, and without the session lock.
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
            // Not latched: a caller-ordering fault that a later `mls_init_storage` resolves.
            throw new Error(
                'MlsError: MLS storage is not initialised - initStorage must succeed before any group ' +
                    'operation, or the operation is silently lost',
            );
        }

        if (this.lease?.held !== true) {
            // Unreachable through `call`, and asserted anyway: this write is what the guard prevents.
            throw refusal(this.lease?.state === 'unsupported' ? 'unsupported' : 'blocked', command);
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

    /** The blob's key, namespaced by account. An un-scoped init gets its own name, never an account's. */
    private blobKey(): string {
        return `state::${this.scope ?? 'unscoped'}`;
    }

    private async read(key: string): Promise<string | undefined> {
        const value = await this.withStore(store => store.get(key));
        if (value === undefined) return undefined;
        if (typeof value !== 'string') {
            // `mls_export_state` returns base64, so anything else here was written by something else.
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

    /** Runs one store operation, reopening once if another tab's upgrade closed the connection. */
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
                // Reported through `available` and by rejecting every call, never as a silent success.
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

/** The refusal for a claim that is not `held`. One place, so both refusals stay one decision. */
function refusal(claim: Exclude<SessionClaim, 'held'>, command: string): Error {
    return claim === 'unsupported'
        ? new MlsSessionGuardUnavailableError(command)
        : new MlsSessionHeldElsewhereError(command);
}
