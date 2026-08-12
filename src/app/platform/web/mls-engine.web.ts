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

/**
 * Another tab of this browser profile owns this account's engine, so this one may not touch it.
 *
 * <p><b>Not latched, unlike the two faults above.</b> It lifts by itself the moment this tab is granted
 * the lock - see {@link WebMlsEngine} on takeover - so a message send that fails with this can succeed
 * on the next attempt without a reload.</p>
 *
 * <p>The wording is constrained by two classifiers and is not free prose. It must not contain "not
 * found", "unknown command" or "not allowed", or `MlsService.callOptional` would read a refusal as a
 * command this build does not define and silently degrade the feature instead of reporting the
 * refusal; and it must contain none of `mls-storage-init.ts`'s `MLS_STATE_UNREADABLE_MARKERS`, or a
 * refusal could be classified as corrupt stored state and answered with a wipe.</p>
 */
export class MlsSessionHeldElsewhereError extends Error {
    constructor(readonly command: string) {
        super(
            `Venta is open in another tab of this browser, and that tab owns this account's encryption `
            + `engine, so ${command} was refused here. Two live engines for one device reuse `
            + `sender-ratchet generations and overwrite each other's group state, which destroys group `
            + `keys silently. Use the other tab, or close it - this one takes the engine over by `
            + `itself once it does.`,
        );
        this.name = 'MlsSessionHeldElsewhereError';
    }
}

/**
 * This browser has no Web Locks API, so single-tab ownership cannot be established at all.
 *
 * <p><b>Fails closed, and that choice is argued in {@link WebMlsEngine}.</b> Same wording constraints as
 * {@link MlsSessionHeldElsewhereError}.</p>
 */
export class MlsSessionGuardUnavailableError extends Error {
    constructor(readonly command: string) {
        super(
            `This browser cannot guarantee that only one tab uses this account's encryption engine - it `
            + `has no Web Locks API, which means either an insecure origin or a browser older than `
            + `Chrome 69 / Firefox 96 / Safari 15.4 - so ${command} was refused. Two tabs sharing one `
            + `engine destroy group keys with nothing reporting it, so this refuses rather than risk `
            + `it. Open Venta over https in a current browser.`,
        );
        this.name = 'MlsSessionGuardUnavailableError';
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
 * deliberately does <b>not</b> do: it does not throw out of `mls_init_storage`. That choice is
 * unchanged and the reason for it is now weaker than it was. It used to be that
 * `MainPageComponent.runDeviceLaunch` answered <i>any</i> `initStorage` rejection by wiping local MLS
 * state, so throwing a transient IndexedDB fault would have destroyed the very blob it could not read.
 * `runMlsStorageInit` classifies that decision now (`mls-storage-init.ts`) and wipes only for a message
 * that says the stored bytes are present and unreadable, so the raw `idb.ts` faults - `unavailable`,
 * `blocked`, `closed` - would classify as `unknown` and be answered with a retry rather than a wipe.
 * Two reasons to keep latching survive that, and both are enough on their own:</p>
 * <ul>
 *   <li>The classifier reads message text, and one failure this catch swallows would match it: the
 *       `does not hold a state blob` phrase {@link WebMlsEngine.read} raises for a foreign value under
 *       the blob key is on the corrupt list. Throwing would hand that case back its wipe.</li>
 *   <li>A latch is the stronger protection regardless of what any caller does with a rejection. A
 *       rejection is one event on the boot path; the latch is what refuses every <i>later</i> mutating
 *       command, and it is those writes - not the failed read - that would overwrite a blob this
 *       adapter could not open. "Nothing restored, and nothing may be written" says more than a
 *       rejection can.</li>
 * </ul>
 * <p>A blob that is genuinely present-but-broken is a different case and does propagate, out of
 * `mls_import_state`, which is exactly what the desktop does with a corrupt `mls_state_{scope}.json`.</p>
 *
 * <h3>Account scope</h3>
 *
 * <p>The blob is keyed by the `scope` argument `mls_init_storage` already carries - the per-account
 * device id - so two accounts in one browser profile never read each other's engine state. That is
 * the only account isolation on this host, because the wasm `mls_init_storage` cannot clear the engine
 * on a scope change the way the native one does (there is no path to compare). It is sufficient only
 * because switching accounts on the web is a full document load; see the note in `wasm.rs`.</p>
 *
 * <h3>One tab at a time, enforced by a Web Lock</h3>
 *
 * <p>Everything above assumes one engine per scope. Two tabs break that assumption in two ways at once:
 * each exports its own snapshot to the same blob key, so the last writer silently discards the other's
 * membership, ratchet generations and pending commits; and two live engines on one MLS leaf reuse
 * sender-ratchet generations, which openmls reads as a replay - at least one tab becomes unable to send
 * - and voids forward secrecy for that leaf. Neither is visible to the user and neither is repairable
 * afterwards. So ownership of a scope is taken as an exclusive {@link SessionLock} named for that scope,
 * and a tab that does not own it does not run engine commands. See `session-lock.ts` for why a Web Lock
 * and not a heartbeat.</p>
 *
 * <p><b>The second tab refuses; it does not run read-only.</b> Read-only is not honest here.
 * `mls_process_message` advances the receiving ratchet and `mls_drain_pending_messages` empties a
 * queue - both are writes - so "reading new messages" is a mutation, and the read-only surface that
 * remains (group info, member lists) has no truthful answer to give anyway: a tab that never held the
 * lock never restored the blob, so its engine is empty and every such read would answer "no such group"
 * for groups this device is in. A confident wrong answer there is worse than a refusal, because callers
 * respond to a missing group by trying to rejoin or re-provision. So the refusal is total, with exactly
 * two exceptions, both deliberate:</p>
 * <ol>
 *   <li><b>`mls_init_storage` resolves `false` instead of rejecting.</b> Its rejection is the signal
 *       `MainPageComponent.runDeviceLaunch` answers by <i>wiping local MLS state</i> - and while
 *       `runMlsStorageInit` now classifies that decision, this adapter must be safe on the boot path
 *       that exists today. A refusal that wipes the blob would destroy the very state the other tab is
 *       working from: the exact loss this guard exists to prevent, caused by the guard. It reports
 *       "nothing restored", refuses every later command, and restores lazily if it ever takes over.
 *       Even after the classifier is wired this stays right, because being blocked by another tab is
 *       not a storage fault at all.</li>
 *   <li><b>`mls_clear_storage` still deletes the blob.</b> It is the one write that cannot resurrect
 *       stale state - a delete cannot overwrite newer state with older - and refusing it would abort
 *       `SessionTeardownService.wipeAccountState` before it deletes this device's <i>signing key</i>,
 *       so a sign-out in the second tab would leave key material behind in the profile. A wipe the
 *       other tab's next mutation re-creates is a lesser failure than a sign-out that does not remove
 *       keys, and it is reported through {@link MlsStateNotPersistedError} either way.</li>
 * </ol>
 *
 * <p><b>{@link available} stays true while blocked</b>, and that is not an oversight. `available` false
 * makes `MlsService.readRegistry` answer `null`, `null` means "this context was never encrypted here",
 * and that answer permits composing cleartext into an encrypted conversation - the §L.9 downgrade.
 * Refusing every command is a loud failure; reporting the engine as absent is a silent downgrade. So a
 * blocked tab fails sends and receives outright rather than quietly dropping to plaintext.</p>
 *
 * <p><b>Takeover is automatic.</b> The blocked tab's lock request stays queued, so when the owning tab
 * is closed or crashes the browser grants it here; the next command notices, restores the blob the other
 * tab left - which is that tab's last durable state, because every mutation persisted before resolving -
 * and proceeds. No reload, and no window in which two engines are live: the lock is granted only after
 * the first is gone.</p>
 *
 * <p><b>And it is announced, because restoring the engine is only half of it.</b> The blocked tab's
 * launch sequence already ran, at boot, and every MLS step in it was refused: no signing key was loaded,
 * no pending Welcome was processed, no key package was uploaded. An engine that is silently ready
 * underneath a UI still reporting "encryption unavailable" is not a takeover, it is a reload waiting to
 * be asked for - so {@link onSessionTakeover} reports the grant and `MainPageComponent` runs the device
 * launch again. See `platform/mls-session.ts`, which is where the extension is declared and why it is
 * not on the port.</p>
 *
 * <p><b>A takeover is not offered while the other tab is alive.</b> `navigator.locks` can steal a lock,
 * and it is deliberately not used: stealing releases the other tab's lock immediately, but an operation
 * already dispatched there can still land its `mls_export_state` write afterwards - so the stealing tab
 * can import the blob, the demoted tab can then write a newer one, and the stealer's next mutation
 * overwrites it. That is the original bug in a smaller window. Making it safe needs a second lock held
 * across dispatch-and-persist as a write barrier, which is worth doing only if a "use it here instead"
 * button is worth it; closing the other tab is one action and needs none of it.</p>
 */
export class WebMlsEngine extends MlsEngine implements MlsSessionTakeover {
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

    private readonly newLock: SessionLockFactory;

    /** Ownership of the current scope. Replaced, not mutated, when the scope changes. */
    private lease: SessionLock | undefined;

    /**
     * A restore that was skipped because another tab owned the scope.
     *
     * <p>Cleared by the takeover, which performs it. Without this a tab that acquires the lock after
     * the owning tab closed would run on an engine that never saw the blob - and then persist that
     * empty engine over it, which is the whole bug with an extra step.</p>
     */
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
        // Started now, not on first call, so `available` has a real answer as early as possible. The
        // rejection is swallowed here and re-raised by `call`, which is the caller that can act on it.
        void this.wasm().catch(() => undefined);
    }

    /** Resolves once the engine is usable, or rejects with why it is not. For boot and for specs. */
    async ready(): Promise<void> {
        await this.wasm();
    }

    /**
     * Whether this tab owns the engine for the current scope, without attempting to take it.
     *
     * <p>For the UI that has to explain a refusal and for the log. Not on {@link MlsEngine}: the port
     * is host-neutral and there is nothing to report on a host with one process.</p>
     */
    sessionState(): SessionState {
        return this.lease?.state ?? 'unclaimed';
    }

    /**
     * Registers a listener for the moment this tab is handed a scope it was refused.
     *
     * <p>The engine is not restored yet when this fires, and deliberately so: the restore is owed to the
     * next command and {@link requireSession} performs it there, so a listener that re-runs the launch
     * sequence gets a restored engine on its first call without this method having to guess which of the
     * two orders a caller wants. What the listener must not assume is that anything has already been
     * read back.</p>
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

        if (command === 'mls_init_storage') return await this.initStorage(module, args) as T;
        // Deliberately before the engine call and deliberately not before `mls_clear_storage`: see the
        // class comment for why a delete is the one write a tab without the lock may still perform.
        if (command === 'mls_clear_storage') return await this.clearStorage<T>(module);

        await this.requireSession(module, command);

        const result = dispatchVentaCrypto<T>(module, command, args);
        if (mutating) await this.persist(module, command);
        return result;
    }

    /**
     * Ownership of the current scope, or the refusal that says why not.
     *
     * <p>Called before every command that is not `mls_init_storage` or `mls_clear_storage`, reads
     * included: `mls_process_message` advances the ratchet, so on this host a read of new messages is a
     * write, and the reads that genuinely only read would be answering out of an engine that never
     * restored the blob.</p>
     */
    private async requireSession(module: VentaCryptoModule, command: string): Promise<void> {
        const claim = await this.session().claim();
        if (claim !== 'held') throw refusal(claim, command);
        if (!this.restoreDeferred) return;

        // Granted after the owning tab went away, so the blob is that tab's last durable state - every
        // mutation there persisted before resolving. Restored here, before this command touches
        // anything, so nothing runs against an engine that is behind storage.
        this.restoreDeferred = false;
        const stateKeyB64 = this.stateKeyB64;
        // No init has succeeded here at all, so there is nothing to restore against and nothing to seal
        // with; `persist` refuses in its own words, which is the honest report of that ordering.
        if (stateKeyB64 === undefined) return;

        await this.restore(module, stateKeyB64);
        // An unreadable blob latches rather than throwing inside `restore`. Surfaced here because this
        // is a command, not the init - a caller that mutates now would write over state it cannot read.
        if (this.fault) throw this.fault;
    }

    /**
     * The lock for the scope this adapter is currently working in.
     *
     * <p>The scope is only known once `mls_init_storage` has supplied it, so a command that arrives
     * before that locks the `unscoped` name - the same name its blob would use. When the scope does
     * arrive the earlier lease is released rather than kept, or an account switch inside one document
     * would hold a lock nothing can ever release.</p>
     */
    private session(): SessionLock {
        const name = sessionLockName(this.scope);
        if (this.lease !== undefined && this.lease.name !== name) {
            this.lease.release();
            this.lease = undefined;
        }
        if (this.lease === undefined) {
            const lease = this.newLock(name);
            // Registered on creation rather than on the first blocked claim, because the grant this is
            // waiting for is delivered by the queued request the lock itself makes - there is no later
            // point at which this adapter is called and could subscribe.
            lease.onGranted(() => this.announceTakeover());
            this.lease = lease;
        }
        return this.lease;
    }

    /**
     * Tells the listeners this tab now owns the scope.
     *
     * <p>Each is isolated: one that throws must not stop the next, because they are independent
     * consumers of the same fact and dropping the rest would leave the tab half-recovered - which is the
     * state this whole mechanism exists to get out of.</p>
     */
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
     * `mls_init_storage`, plus the restore the desktop gets from its state file.
     *
     * <p>The wasm command itself only validates: it requires the state key and always answers `false`,
     * because there is no file to have found. The restore is this method's job, and its `true` is what
     * makes `MlsService.initStorage`'s documented contract - "true when state was restored" - mean the
     * same thing on both hosts.</p>
     *
     * <p>It is also where this tab claims the scope, because the scope arrives with these arguments and
     * not before. A tab that does not get it reports `false` and refuses everything afterwards - it does
     * <b>not</b> reject, for the reason set out in the class comment: on the boot path that exists
     * today, a rejection here is answered by wiping the local state the other tab is working from.</p>
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

        const claim = await this.session().claim();
        if (claim !== 'held') {
            // Nothing is read and nothing is written. The restore is owed to whichever moment this tab
            // is granted the lock, if it ever is.
            this.restoreDeferred = true;
            // The only report a user gets until the banner below exists. Deliberately a warning rather
            // than silence: a blocked tab looks like a working one until the first send fails.
            //
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
     *     read - the second case latching {@link MlsStateUnreadableError} rather than throwing, so that
     *     `mls_init_storage` never answers a transient IndexedDB fault with a wipe.
     */
    private async restore(module: VentaCryptoModule, stateKeyB64: string): Promise<boolean> {
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
     *
     * <p><b>Runs without the session lock</b>, and that exception is argued in the class comment: a
     * delete cannot overwrite newer state with older, and refusing it would abort the sign-out that
     * deletes this device's signing key.</p>
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

        if (this.lease?.held !== true) {
            // Unreachable through `call`, which claims the scope first, and asserted anyway: this write
            // is the exact act the guard exists to prevent, so it refuses on its own account rather
            // than trusting every present and future path into it to have checked. Nothing here is a
            // safe default, so there is no "assume held".
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

/** The refusal for a claim that is not `held`. One place, so both refusals stay one decision. */
function refusal(claim: Exclude<SessionClaim, 'held'>, command: string): Error {
    return claim === 'unsupported'
        ? new MlsSessionGuardUnavailableError(command)
        : new MlsSessionHeldElsewhereError(command);
}
