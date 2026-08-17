import {IDBFactory as FakeIdbFactory} from 'fake-indexeddb';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {FakeLockManager} from '../testing/fake-lock-manager';
import {
    MLS_MUTATING_COMMANDS,
    MlsSessionGuardUnavailableError,
    MlsSessionHeldElsewhereError,
    MlsStateNotPersistedError,
    MlsStateUnreadableError,
    WebMlsEngine,
} from './mls-engine.web';
import {IdbStore, openStore} from './idb';
import {SessionLock, WebLocksSessionLock} from './session-lock';
import {VentaCryptoModule} from './venta-crypto';

/**
 * The web MLS adapter's persistence, which is the one place this port diverges from the desktop.
 *
 * <p><b>Why this file is the highest-value test in the track.</b> `MlsState::save_to_disk` is a no-op on
 * `wasm32`: every engine operation that "persists" succeeds in a browser without writing anything. So
 * the adapter has to call `mls_export_state` after each mutating command and keep the blob in
 * IndexedDB. Get that wrong and a user's group membership, ratchet state and message history vanish on
 * refresh, with no error anywhere - and a test that mutated and then asserted against the same
 * in-memory engine would pass the whole time.</p>
 *
 * <p>So every assertion here crosses a <b>reload</b>: {@link reload} throws the engine and the module
 * away and builds new ones over the same IndexedDB, exactly as a page refresh does. Nothing in the fake
 * module below persists anything by itself - that is the divergence being modelled, not an omission -
 * so a passing assertion after a reload can only have come from the blob.</p>
 *
 * <p>Driven against <b>fake-indexeddb</b>, a real implementation of the spec, so transactions, aborts
 * and structured clone behave as they do in a browser. The wasm module is faked; that half is proved
 * elsewhere, by `parity_tests.rs` running on real `wasm32` against venta-mobile's golden vectors.</p>
 */

const STATE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const DEVICE_A = 'device-a';
const DB_NAME = 'alpine-mls-state';
const STORE_NAME = 'state';

/**
 * A stand-in for the wasm module: an engine with in-memory state and no autosave.
 *
 * <p>It models the two things this adapter is built around - state that is lost when the page goes, and
 * `mls_export_state` / `mls_import_state` as the only way to move it - and nothing else. Commands are
 * recorded so the *order* can be asserted, because "exported after the mutation" and "exported instead
 * of it" are the same call count.</p>
 */
class FakeEngineModule implements VentaCryptoModule {
    /** The groups this "page" holds. Deliberately not shared between instances. */
    groups: string[] = [];

    readonly calls: string[] = [];

    /** Set to make `mls_export_state` throw, standing in for an engine that cannot seal its state. */
    exportError: string | undefined;

    default = async (): Promise<void> => undefined;

    [command: string]: unknown;

    mls_init_storage = (json: string): string => {
        this.calls.push('mls_init_storage');
        const args = JSON.parse(json) as {stateKeyB64?: string};
        if (!args.stateKeyB64) {
            // The native wording, verbatim, because `mls.service.ts`'s classifier is meant to tell this
            // from a corrupt state file and only the second wipes a device's groups.
            throw (
                'MlsError: no state key was supplied - mls_state.json cannot be written unsealed, so ' +
                'encryption stays unavailable until the keychain produces one'
            );
        }
        return JSON.stringify(false);
    };

    mls_create_group = (json: string): string => {
        this.calls.push('mls_create_group');
        const args = JSON.parse(json) as {groupIdB64: string};
        this.groups.push(args.groupIdB64);
        return JSON.stringify({groupId: args.groupIdB64, epoch: 0, ownLeafIndex: 0, members: []});
    };

    mls_get_group_info = (json: string): string => {
        this.calls.push('mls_get_group_info');
        const args = JSON.parse(json) as {groupIdB64: string};
        if (!this.groups.includes(args.groupIdB64)) throw 'GroupNotFound: group not found';
        return JSON.stringify({groupId: args.groupIdB64, epoch: 0, ownLeafIndex: 0, members: []});
    };

    mls_export_state = (json: string): string => {
        this.calls.push('mls_export_state');
        if (this.exportError) throw this.exportError;
        const args = JSON.parse(json) as {encryptionKeyB64: string};
        return JSON.stringify(`${args.encryptionKeyB64}|${this.groups.join(',')}`);
    };

    mls_import_state = (json: string): string => {
        this.calls.push('mls_import_state');
        const args = JSON.parse(json) as {encryptedB64: string; encryptionKeyB64: string};
        const [key, groups] = args.encryptedB64.split('|');
        if (key !== args.encryptionKeyB64) throw 'MlsError: state file is unreadable: wrong key';
        this.groups = groups ? groups.split(',') : [];
        return JSON.stringify(null);
    };

    mls_clear_storage = (): string => {
        this.calls.push('mls_clear_storage');
        this.groups = [];
        return JSON.stringify(null);
    };

    /** Stands in for every other mutating command: it changes state and persists nothing itself. */
    mls_send_message = (json: string): string => {
        this.calls.push('mls_send_message');
        const args = JSON.parse(json) as {groupIdB64: string};
        this.groups.push(`${args.groupIdB64}#sent`);
        return JSON.stringify({ciphertext: 'Y3Q=', epoch: 1});
    };
}

/** One browser profile's IndexedDB, surviving every reload in a test. */
let factory: IDBFactory;
/**
 * One browser profile's lock manager, likewise.
 *
 * <p>Shared by every engine a test builds, because that is what makes two engines here behave as two
 * tabs: the single-session guard is nothing but contention on this object. jsdom has no
 * `navigator.locks` of its own, so without it every adapter would report `unsupported` and refuse.</p>
 */
let profile: FakeLockManager;
let module: FakeEngineModule;
let engine: WebMlsEngine;
/** The tab `engine` belongs to, so a reload can end it the way closing a tab does. */
let tab: Tab | undefined;

/** Opens the adapter's store the way the adapter itself would, against the test's factory. */
function open(): Promise<IdbStore> {
    return openStore(DB_NAME, STORE_NAME, {factory});
}

/** One tab of this profile: its own engine and module, the profile's storage and lock manager. */
interface Tab {
    readonly engine: WebMlsEngine;
    readonly module: FakeEngineModule;
    /** This tab goes away. The browser releases its lock however the tab ended - crash included. */
    close(): void;
}

/**
 * Opens a tab whose store is the profile's, with `overrides` applied to it.
 *
 * <p>The lock manager is the profile's, which is what makes two tabs here contend as two tabs do.</p>
 */
function openTab(overrides: Partial<IdbStore> = {}): Tab {
    const tabModule = new FakeEngineModule();
    let tabLock: SessionLock | undefined;
    const tabEngine = new WebMlsEngine(
        async () => tabModule,
        () => storeWith(overrides),
        name => (tabLock = new WebLocksSessionLock(name, profile)),
    );
    return {
        engine: tabEngine,
        module: tabModule,
        close: () => tabLock?.release(),
    };
}

/**
 * A page load: a new engine, a new module, the same storage.
 *
 * <p>This is the whole harness. Every assertion about persistence has to survive one of these, because
 * anything that only survives inside one is exactly the bug.</p>
 *
 * <p>It ends the previous tab first, because a reload is not a second tab: leaving the old lock held
 * would make every test below assert the guard's refusal instead of what it is about.</p>
 */
function reload(overrides: Partial<IdbStore> = {}): void {
    tab?.close();
    const next = openTab(overrides);
    tab = next;
    module = next.module;
    engine = next.engine;
}

/** Lets queued lock grants run. A grant crosses microtasks here as it crosses a task in a browser. */
async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** What `MlsService.initStorage()` sends. */
function initArgs(scope = DEVICE_A) {
    return {stateKeyB64: STATE_KEY, scope, adoptLegacy: false};
}

/**
 * One store with some operations replaced.
 *
 * <p>Delegating explicitly rather than spreading the store: `openStore` returns a class instance, and
 * `{...store}` copies none of its prototype methods - which does not present as an empty object but as
 * whichever unrelated failure the first missing method produces. Two tests here "passed" that way.</p>
 */
async function storeWith(overrides: Partial<IdbStore>): Promise<IdbStore> {
    const store = await open();
    return {
        dbName: store.dbName,
        storeName: store.storeName,
        get: key => store.get(key),
        set: (key, value) => store.set(key, value),
        delete: key => store.delete(key),
        keys: () => store.keys(),
        clear: () => store.clear(),
        close: () => store.close(),
        ...overrides,
    };
}

beforeEach(() => {
    factory = new FakeIdbFactory();
    profile = new FakeLockManager();
    tab = undefined;
    reload();
});

describe('WebMlsEngine persistence', () => {
    it('keeps a group across a reload, which no autosave does for it', async () => {
        await engine.call('mls_init_storage', initArgs());
        await engine.call('mls_create_group', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h'});

        // The engine that created the group is gone, along with everything it held in memory.
        reload();
        const restored = await engine.call<boolean>('mls_init_storage', initArgs());

        expect(restored).toBe(true);
        await expect(engine.call('mls_get_group_info', {groupIdB64: 'Z3JvdXAx'})).resolves.toBeTruthy();
    });

    it('reports starting fresh when there is nothing stored', async () => {
        await expect(engine.call<boolean>('mls_init_storage', initArgs())).resolves.toBe(false);
    });

    it('exports after the mutation rather than instead of it', async () => {
        await engine.call('mls_init_storage', initArgs());
        module.calls.length = 0;

        await engine.call('mls_send_message', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h', plaintextB64: 'aGk='});

        // Order matters and a call count cannot see it: exporting first would seal the state the
        // operation was about to change.
        expect(module.calls).toEqual(['mls_send_message', 'mls_export_state']);
    });

    it('does not export after a read', async () => {
        await engine.call('mls_init_storage', initArgs());
        await engine.call('mls_create_group', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h'});
        module.calls.length = 0;

        await engine.call('mls_get_group_info', {groupIdB64: 'Z3JvdXAx'});

        expect(module.calls).toEqual(['mls_get_group_info']);
    });

    it('scopes the blob by account, so two accounts never read each other state', async () => {
        await engine.call('mls_init_storage', initArgs(DEVICE_A));
        await engine.call('mls_create_group', {groupIdB64: 'YWNjb3VudEE=', keyHandle: 'h'});

        // A second account in the same browser profile. On web this only ever happens after a document
        // load - the WASM `mls_init_storage` cannot clear the engine on a scope change, because there
        // is no state path to compare - so the scope in the blob key is the whole of the isolation.
        reload();
        const restored = await engine.call<boolean>('mls_init_storage', initArgs('device-b'));

        expect(restored).toBe(false);
        await expect(engine.call('mls_get_group_info', {groupIdB64: 'YWNjb3VudEE='})).rejects.toBe(
            'GroupNotFound: group not found',
        );
    });

    it('refuses a mutation before initStorage, rather than performing an unpersistable one', async () => {
        // Native's `save_to_disk` with no `state_path` is an error, not a no-op, for exactly this
        // reason: it used to return `Ok(())`, and every group an uninitialised engine joined vanished
        // on the next launch with nothing saying so.
        await expect(
            engine.call('mls_create_group', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h'}),
        ).rejects.toThrow(/MLS storage is not initialised/);
    });

    it('recovers from that on the next initStorage, because import replaces rather than merges', async () => {
        await engine
            .call('mls_create_group', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h'})
            .catch(() => undefined);

        // Not latched, unlike a failed write: the ordering fault fixes itself, and refusing forever
        // would take the page down for something recoverable.
        await engine.call('mls_init_storage', initArgs());
        await expect(
            engine.call('mls_create_group', {groupIdB64: 'Z3JvdXAy', keyHandle: 'h'}),
        ).resolves.toBeTruthy();
    });

    it('refuses the state key being absent, in the engine own words', async () => {
        // Not paraphrased and not wrapped: `mls.service.ts`'s classifier is meant to tell a transient
        // key-store failure from a corrupt state file, and only the second wipes a device's groups.
        await expect(engine.call('mls_init_storage', {scope: DEVICE_A, adoptLegacy: false})).rejects.toMatch(
            /no state key was supplied/,
        );
    });
});

describe('WebMlsEngine when the state cannot be written', () => {
    beforeEach(async () => {
        await engine.call('mls_init_storage', initArgs());
        await engine.call('mls_create_group', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h'});
    });

    it('refuses the operation rather than reporting a success that will not survive', async () => {
        module.exportError = 'MlsError: could not seal the state';

        await expect(
            engine.call('mls_send_message', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h', plaintextB64: 'aGk='}),
        ).rejects.toBeInstanceOf(MlsStateNotPersistedError);
    });

    it('latches, so nothing piles more unpersisted work onto a diverged engine', async () => {
        module.exportError = 'MlsError: could not seal the state';
        await expect(
            engine.call('mls_send_message', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h', plaintextB64: 'aGk='}),
        ).rejects.toBeInstanceOf(MlsStateNotPersistedError);

        // Even with the fault gone: a mixture of persisted and unpersisted operations is the one state
        // a reload cannot repair, so the refusal stands until the page is reloaded.
        module.exportError = undefined;
        module.calls.length = 0;
        await expect(
            engine.call('mls_create_group', {groupIdB64: 'Z3JvdXAy', keyHandle: 'h'}),
        ).rejects.toBeInstanceOf(MlsStateNotPersistedError);
        expect(module.calls).toEqual([]);
    });

    it('keeps answering reads, which cannot deepen the divergence', async () => {
        module.exportError = 'MlsError: could not seal the state';
        await expect(
            engine.call('mls_send_message', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h', plaintextB64: 'aGk='}),
        ).rejects.toBeInstanceOf(MlsStateNotPersistedError);

        await expect(engine.call('mls_get_group_info', {groupIdB64: 'Z3JvdXAx'})).resolves.toBeTruthy();
    });

    it('rolls back to the last durable state on the reload it asks for', async () => {
        module.exportError = 'MlsError: could not seal the state';
        await engine
            .call('mls_send_message', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h', plaintextB64: 'aGk='})
            .catch(() => undefined);

        reload();
        await engine.call('mls_init_storage', initArgs());

        // The group survives; the refused send is gone, as it must be - the caller never published its
        // ciphertext, so the group never saw the operation either.
        expect(module.groups).toEqual(['Z3JvdXAx']);
    });
});

describe('WebMlsEngine when the stored state cannot be read', () => {
    beforeEach(async () => {
        await engine.call('mls_init_storage', initArgs());
        await engine.call('mls_create_group', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h'});
    });

    /** A reload whose store rejects every read - a `blocked` upgrade, a transient IndexedDB fault. */
    function reloadWithUnreadableStore(): void {
        reload({
            get: async () => {
                throw new Error('the database is blocked');
            },
        });
    }

    it('does not throw out of initStorage, because the caller answer to that is a wipe', async () => {
        reloadWithUnreadableStore();

        // `MainPageComponent.runDeviceLaunch` treats any `initStorage` rejection as a corrupt state file
        // and wipes local MLS state. For a transient read failure that would destroy the very blob it
        // could not read, so this reports "nothing restored" and refuses to write instead.
        await expect(engine.call<boolean>('mls_init_storage', initArgs())).resolves.toBe(false);
    });

    it('refuses every mutation rather than overwriting state it could not read', async () => {
        reloadWithUnreadableStore();
        await engine.call('mls_init_storage', initArgs());

        await expect(
            engine.call('mls_create_group', {groupIdB64: 'Z3JvdXAy', keyHandle: 'h'}),
        ).rejects.toBeInstanceOf(MlsStateUnreadableError);
    });

    it('leaves the blob intact, so the next load can still recover it', async () => {
        reloadWithUnreadableStore();
        await engine.call('mls_init_storage', initArgs());
        await engine
            .call('mls_create_group', {groupIdB64: 'Z3JvdXAy', keyHandle: 'h'})
            .catch(() => undefined);
        await engine.call('mls_clear_storage').catch(() => undefined);

        // The fault was transient; the state is still there.
        reload();
        await expect(engine.call<boolean>('mls_init_storage', initArgs())).resolves.toBe(true);
        expect(module.groups).toEqual(['Z3JvdXAx']);
    });

    it('propagates a blob that is present and broken, which is the desktop corrupt-file case', async () => {
        // Not the same event as a read failure: this blob cannot be restored by any later attempt, so
        // the launch sequence should take the recovery it takes on the desktop for a corrupt
        // `mls_state_{scope}.json`.
        const store = await open();
        await store.set(`state::${DEVICE_A}`, 'a-different-key|Z3JvdXAx');
        store.close();

        reload();
        await expect(engine.call('mls_init_storage', initArgs())).rejects.toMatch(/unreadable/);
    });
});

describe('WebMlsEngine clearing', () => {
    it('deletes the blob, so a wipe survives the reload', async () => {
        await engine.call('mls_init_storage', initArgs());
        await engine.call('mls_create_group', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h'});

        await engine.call('mls_clear_storage');

        reload();
        await expect(engine.call<boolean>('mls_init_storage', initArgs())).resolves.toBe(false);
        expect(module.groups).toEqual([]);
    });

    it('reports a wipe that did not reach storage', async () => {
        reload({
            delete: async () => {
                throw new Error('the database is read-only');
            },
        });
        await engine.call('mls_init_storage', initArgs());

        // A wipe that did not wipe leaves this account's key material for whoever uses the browser
        // next, so it must not resolve.
        await expect(engine.call('mls_clear_storage')).rejects.toBeInstanceOf(MlsStateNotPersistedError);
    });
});

describe('WebMlsEngine availability', () => {
    it('is available once the module has loaded', async () => {
        await engine.ready();
        expect(engine.available).toBe(true);
    });

    it('reports a module that failed to load, and refuses every call loudly', async () => {
        const broken = new WebMlsEngine(
            async () => {
                throw new Error('chunk load failed');
            },
            open,
            name => new WebLocksSessionLock(name, profile),
        );

        await expect(broken.ready()).rejects.toThrow(/chunk load failed/);
        expect(broken.available).toBe(false);
        // Not a resolved value and not a silent no-op: "it crashes earlier" is not an access control,
        // and reporting success for an operation that never happened is the failure being avoided.
        await expect(broken.call('mls_get_group_info', {groupIdB64: 'Z3JvdXAx'})).rejects.toThrow(
            /chunk load failed/,
        );
    });

    it('is optimistic before the load resolves, which the encryption floor depends on', async () => {
        // `MlsService.readRegistry` answers "nothing recorded here" when the engine is unavailable, and
        // that answer for `#floor` permits cleartext. Reading "still loading" as unavailable would make
        // the first second of every boot a §L.9 downgrade window.
        const slow = new WebMlsEngine(() => new Promise(() => undefined), open);
        expect(slow.available).toBe(true);
    });
});

/**
 * The single-session guard: only one tab of a browser profile may hold a live engine for a scope.
 *
 * <p><b>Why the harness is shaped as it is.</b> Two tabs of one account each hold their own in-memory
 * engine and each exports it to `state::${scope}`, so without a guard the last writer silently discards
 * the other's membership, ratchet generations and pending commits - and two live engines on one leaf
 * reuse sender-ratchet generations, which breaks sending for that leaf and voids its forward secrecy.
 * So every test here runs <i>two engines against one {@link FakeLockManager} and one IndexedDB</i>: the
 * shared manager is the profile, and giving each tab its own would make all of this pass vacuously.</p>
 *
 * <p>The assertions that matter are about the <b>blob</b>, not about the lock: that the second tab's
 * mutation never reaches storage, and that what the first tab wrote is what a later load reads. A test
 * asserting that `request` was called would prove nothing at all.</p>
 */
describe('WebMlsEngine with two tabs in one browser profile', () => {
    const GROUP = 'Z3JvdXAx';
    const sendArgs = {groupIdB64: GROUP, keyHandle: 'h', plaintextB64: 'aGk='};

    /** The tab that got there first, holding the lock for `DEVICE_A` with a group in its engine. */
    let first: Tab;
    /** A second tab of the same account, opened while the first is still live. */
    let second: Tab;

    beforeEach(async () => {
        // The harness' own tab would hold the lock and confuse which engine is which.
        tab?.close();
        tab = undefined;

        first = openTab();
        await first.engine.call('mls_init_storage', initArgs());
        await first.engine.call('mls_create_group', {groupIdB64: GROUP, keyHandle: 'h'});

        second = openTab();
    });

    it('lets the first tab own the scope', async () => {
        expect(first.engine.sessionState()).toBe('held');
        await expect(first.engine.call('mls_get_group_info', {groupIdB64: GROUP})).resolves.toBeTruthy();
    });

    it('reports the second tab as blocked rather than starting a second engine', async () => {
        await expect(second.engine.call<boolean>('mls_init_storage', initArgs())).resolves.toBe(false);

        expect(second.engine.sessionState()).toBe('blocked');
    });

    it('refuses a mutation from the second tab', async () => {
        await second.engine.call('mls_init_storage', initArgs());

        await expect(second.engine.call('mls_send_message', sendArgs)).rejects.toBeInstanceOf(
            MlsSessionHeldElsewhereError,
        );
    });

    it('does not run the command in the second tab engine either', async () => {
        await second.engine.call('mls_init_storage', initArgs());
        second.module.calls.length = 0;

        await second.engine.call('mls_send_message', sendArgs).catch(() => undefined);

        // Refused before the engine, not after: an operation that ran and then failed to persist has
        // already advanced this leaf's ratchet, which is the half of the hazard storage cannot undo.
        expect(second.module.calls).toEqual([]);
    });

    it('does not write the blob from the second tab', async () => {
        await second.engine.call('mls_init_storage', initArgs());
        const before = await blob();

        await second.engine.call('mls_send_message', sendArgs).catch(() => undefined);
        await second.engine
            .call('mls_create_group', {groupIdB64: 'Z3JvdXAy', keyHandle: 'h'})
            .catch(() => undefined);

        expect(await blob()).toBe(before);
    });

    it('leaves the first tab state intact for the next load, which is the loss being prevented', async () => {
        await second.engine.call('mls_init_storage', initArgs());
        await second.engine.call('mls_send_message', sendArgs).catch(() => undefined);

        // What the surviving tab persisted is what storage holds. Without the guard the second tab's
        // empty-engine export would be here instead, and this device's group would be gone.
        second.close();
        first.close();
        await settle();
        reload();
        await expect(engine.call<boolean>('mls_init_storage', initArgs())).resolves.toBe(true);
        expect(module.groups).toEqual([GROUP]);
    });

    it('refuses reads in the second tab as well, rather than answering from an engine with no state', async () => {
        await second.engine.call('mls_init_storage', initArgs());

        // The read-only tab is not honest here. `mls_process_message` advances the ratchet, so receiving
        // is a write; and this engine never restored the blob, so "no such group" would be a confident
        // wrong answer that callers respond to by trying to rejoin.
        await expect(second.engine.call('mls_get_group_info', {groupIdB64: GROUP})).rejects.toBeInstanceOf(
            MlsSessionHeldElsewhereError,
        );
    });

    it('never wipes stored state on being blocked, because init resolves rather than rejects', async () => {
        // `MainPageComponent.runDeviceLaunch` answers an `initStorage` rejection by wiping local MLS
        // state. A guard that rejected here would destroy the state the other tab is working from - the
        // exact loss it exists to prevent, caused by the guard.
        await expect(second.engine.call('mls_init_storage', initArgs())).resolves.toBe(false);
        expect(await blob()).toBeTypeOf('string');
    });

    it('takes the engine over when the first tab closes, with no reload', async () => {
        await second.engine.call('mls_init_storage', initArgs());

        first.close();
        await settle();

        // The blocked request was queued, so the browser grants it here. The takeover restores the blob
        // the other tab left before running anything, which is why the group is present.
        await expect(second.engine.call('mls_get_group_info', {groupIdB64: GROUP})).resolves.toBeTruthy();
        expect(second.engine.sessionState()).toBe('held');
    });

    it('restores the other tab state before mutating on takeover, not after', async () => {
        await second.engine.call('mls_init_storage', initArgs());

        first.close();
        await settle();
        await second.engine.call('mls_send_message', sendArgs);

        // Both the group the first tab created and this tab's send. Persisting first and importing
        // afterwards - or not importing at all - would have written an engine holding only the send,
        // silently dropping the group.
        expect(second.module.groups).toEqual([GROUP, `${GROUP}#sent`]);
        second.close();
        await settle();
        reload();
        await engine.call('mls_init_storage', initArgs());
        expect(module.groups).toEqual([GROUP, `${GROUP}#sent`]);
    });

    it('does not import the blob into a tab that is only blocked', async () => {
        await second.engine.call('mls_init_storage', initArgs());

        // A blocked tab holding a snapshot is how a stale write happens: it would be behind the owning
        // tab from the moment it read. Nothing is imported until the lock is actually held.
        expect(second.module.calls).toEqual(['mls_init_storage']);
        expect(second.module.groups).toEqual([]);
    });

    it('lets a second account work in the second tab, because the lock names the scope', async () => {
        // Two accounts in one profile have two device ids, two blobs and no shared engine state, so one
        // must not lock the other out - the guard is per scope for the same reason `state::${scope}` is.
        await expect(second.engine.call<boolean>('mls_init_storage', initArgs('device-b'))).resolves.toBe(
            false,
        );
        await expect(
            second.engine.call('mls_create_group', {groupIdB64: 'YWNjb3VudEI=', keyHandle: 'h'}),
        ).resolves.toBeTruthy();
        expect(second.engine.sessionState()).toBe('held');
    });

    it('still lets a blocked tab wipe, so signing out does not leave keys behind', async () => {
        await second.engine.call('mls_init_storage', initArgs());

        // The one write a tab without the lock may perform: a delete cannot overwrite newer state with
        // older, and refusing it would abort `SessionTeardownService.wipeAccountState` before it deletes
        // this device's signing key.
        await expect(second.engine.call('mls_clear_storage')).resolves.toBeNull();
        expect(await blob()).toBeUndefined();
    });

    it('refuses the second tab in its own words, and not in words two classifiers read as something else', async () => {
        await second.engine.call('mls_init_storage', initArgs());
        const message = await second.engine.call('mls_send_message', sendArgs).then(
            () => '',
            (err: unknown) => (err as Error).message,
        );

        expect(message).toContain('another tab');
        // `MlsService.callOptional` reads the command name plus "not found"/"unknown command"/"not
        // allowed" as a command this build does not define, and answers by degrading the feature
        // silently. A refusal must never be readable that way.
        expect(message).not.toMatch(/not\s+found|unknown command|not\s+allowed/i);
        // And `classifyMlsStorageFault` reads these as "the stored state is present and unreadable",
        // whose licence is to delete the user's only copy of their group keys.
        for (const marker of [
            "did not open with this device's state key",
            'is listed in state but its data is missing from storage',
            'failed to load group',
            'encrypted blob too short',
            'aead::Error',
            'does not hold a state blob',
        ]) {
            expect(message).not.toContain(marker);
        }
    });

    it('does not persist an operation whose ownership went away while it ran', async () => {
        // The narrow window the export is guarded against on its own account: ownership is checked
        // before the command, and the write happens after it. Modelled by making the engine give the
        // scope up as a side effect of the command - which is what a lease switch mid-operation would
        // do - because if that write landed it would be exactly the stale overwrite the guard is for.
        const before = await blob();
        const send = first.module.mls_send_message;
        first.module.mls_send_message = (json: string): string => {
            first.close();
            return send(json);
        };

        await expect(first.engine.call('mls_send_message', sendArgs)).rejects.toBeInstanceOf(
            MlsSessionHeldElsewhereError,
        );
        expect(await blob()).toBe(before);
    });

    /**
     * The other half of a takeover: the launch sequence, which nothing else will run again.
     *
     * <p>Restoring the engine is not enough on its own. The blocked tab's launch already ran, at boot,
     * against an engine that refused everything - no signing key loaded, no pending Welcome processed,
     * no key package uploaded - and there is no later moment at which any of that is retried. Without a
     * report the tab keeps showing "encryption unavailable" over a working engine until it is reloaded,
     * which is precisely what the queued lock request exists to make unnecessary.</p>
     */
    describe('reporting the takeover', () => {
        it('tells a listener when the scope is handed over', async () => {
            await second.engine.call('mls_init_storage', initArgs());
            let handovers = 0;
            second.engine.onSessionTakeover(() => handovers++);

            first.close();
            await settle();

            expect(handovers).toBe(1);
        });

        it('says nothing on a first claim, which is not a takeover', async () => {
            // A listener that could not tell the two apart would run the whole launch sequence a second
            // time on every cold start, in every tab, including the one that was never blocked.
            const fresh = openTab();
            let handovers = 0;
            fresh.engine.onSessionTakeover(() => handovers++);

            await fresh.engine.call('mls_init_storage', initArgs('device-c'));
            await settle();

            expect(handovers).toBe(0);
            expect(fresh.engine.sessionState()).toBe('held');
        });

        it('says nothing while the other tab is still there', async () => {
            let handovers = 0;
            second.engine.onSessionTakeover(() => handovers++);

            await second.engine.call('mls_init_storage', initArgs());
            await settle();

            expect(handovers).toBe(0);
        });

        it('hands the listener an engine a relaunch can actually use', async () => {
            // The assertion that matters: a listener that re-runs the launch must find the group the
            // other tab left, not an empty engine it would then persist over the top of.
            await second.engine.call('mls_init_storage', initArgs());
            let relaunched: Promise<boolean> | undefined;
            second.engine.onSessionTakeover(() => {
                relaunched = second.engine.call<boolean>('mls_init_storage', initArgs());
            });

            first.close();
            await settle();

            // `true` is "state was restored". A listener that found `false` would be relaunching onto
            // an empty engine and would then persist it over the other tab's blob.
            await expect(relaunched).resolves.toBe(true);
            await expect(second.engine.call('mls_get_group_info', {groupIdB64: GROUP})).resolves.toBeTruthy();
        });

        it('stops calling a listener that has been removed', async () => {
            await second.engine.call('mls_init_storage', initArgs());
            let handovers = 0;
            const off = second.engine.onSessionTakeover(() => handovers++);
            off();

            first.close();
            await settle();

            expect(handovers).toBe(0);
        });

        it('keeps calling the rest when one listener throws', async () => {
            await second.engine.call('mls_init_storage', initArgs());
            const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            let reached = false;
            second.engine.onSessionTakeover(() => {
                throw new Error('the launch sequence blew up');
            });
            second.engine.onSessionTakeover(() => (reached = true));

            try {
                first.close();
                await settle();

                // They are independent consumers of one fact, and dropping the rest would leave the tab
                // half-recovered - the state this whole mechanism exists to get out of.
                expect(reached).toBe(true);
            } finally {
                error.mockRestore();
            }
        });

        it('does not lose the lock when a listener throws', async () => {
            await second.engine.call('mls_init_storage', initArgs());
            const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            second.engine.onSessionTakeover(() => {
                throw new Error('the launch sequence blew up');
            });

            try {
                first.close();
                await settle();

                // A throw that escaped into `navigator.locks.request`'s callback would settle it, which
                // releases the lock this tab has just been granted - the takeover undoing itself.
                expect(second.engine.sessionState()).toBe('held');
                await expect(
                    second.engine.call('mls_get_group_info', {groupIdB64: GROUP}),
                ).resolves.toBeTruthy();
            } finally {
                error.mockRestore();
            }
        });
    });

    /** The sealed blob for `DEVICE_A`, read outside both engines. The only durable state there is. */
    async function blob(): Promise<string | undefined> {
        const store = await open();
        try {
            const value = await store.get(`state::${DEVICE_A}`);
            return typeof value === 'string' ? value : undefined;
        } finally {
            store.close();
        }
    }
});

/**
 * A browser with no Web Locks API: an insecure origin, or a browser older than Chrome 69 / Firefox 96 /
 * Safari 15.4.
 *
 * <p><b>Fails closed.</b> The alternative is failing open with a warning, and the two costs are not
 * comparable: refusing costs a small population an encrypted client they can restore by updating the
 * browser or by using https, while proceeding costs whoever opens a second tab their group keys, with
 * nothing reporting it and no way back. `available` deliberately stays true, because false there makes
 * `MlsService.readRegistry` answer "never encrypted here" and that answer permits cleartext.</p>
 */
describe('WebMlsEngine where the browser has no Web Locks', () => {
    let unguarded: WebMlsEngine;

    beforeEach(() => {
        unguarded = new WebMlsEngine(
            async () => module,
            open,
            name => new WebLocksSessionLock(name, undefined),
        );
    });

    it('refuses every command rather than risking a second engine', async () => {
        await unguarded.call('mls_init_storage', initArgs());

        await expect(
            unguarded.call('mls_create_group', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h'}),
        ).rejects.toBeInstanceOf(MlsSessionGuardUnavailableError);
    });

    it('says why, in terms that name the browser rather than the operation', async () => {
        await unguarded.call('mls_init_storage', initArgs());
        const message = await unguarded
            .call('mls_send_message', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h', plaintextB64: 'aGk='})
            .then(
                () => '',
                (err: unknown) => (err as Error).message,
            );

        expect(message).toContain('Web Locks');
        expect(message).not.toMatch(/not\s+found|unknown command|not\s+allowed/i);
    });

    it('keeps reporting the engine as available, so nothing downgrades to cleartext', async () => {
        await unguarded.ready();

        // `available` false is not a stricter refusal, it is a *looser* one: it makes `readRegistry`
        // answer "this context was never encrypted here", which permits composing cleartext into an
        // encrypted conversation. Refusing commands is the loud failure; this flag is not the place.
        expect(unguarded.available).toBe(true);
    });

    it('does not write the blob', async () => {
        await unguarded.call('mls_init_storage', initArgs());
        await unguarded
            .call('mls_create_group', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h'})
            .catch(() => undefined);

        const store = await open();
        try {
            expect(await store.get(`state::${DEVICE_A}`)).toBeUndefined();
        } finally {
            store.close();
        }
    });

    it('does not reject out of initStorage when the lock machinery itself fails', async () => {
        // The rejection that costs group keys: `MainPageComponent.runDeviceLaunch` answers an
        // `initStorage` rejection by wiping local MLS state, so a broken lock manager must degrade to a
        // refusal rather than raise here.
        const refusing = new WebMlsEngine(
            async () => module,
            open,
            name =>
                new WebLocksSessionLock(name, {
                    request: () => Promise.reject(new Error('nope')),
                    query: () => Promise.reject(new Error('nope')),
                } as LockManager),
        );

        await expect(refusing.call<boolean>('mls_init_storage', initArgs())).resolves.toBe(false);
        await expect(
            refusing.call('mls_create_group', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h'}),
        ).rejects.toBeInstanceOf(MlsSessionGuardUnavailableError);
    });

    it('warns on the boot path, because a refusing tab otherwise looks like a working one', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await unguarded.call('mls_init_storage', initArgs());
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0]?.[0])).toContain('Web Locks');
        } finally {
            warn.mockRestore();
        }
    });
});

describe('the mutating command set', () => {
    it('names every command whose engine function calls save_to_disk, and nothing else', () => {
        // Pinned as a list rather than derived from the names, because the names do not decide it:
        // `mls_generate_key_packages_with_handle` takes `&MlsState` and still persists - openmls'
        // provider store mutates through `&self` - while `mls_load_signing_key` takes `&mut` and does
        // not, because signers are session state that `to_persisted` excludes.
        expect([...MLS_MUTATING_COMMANDS].sort()).toEqual([
            'generate_mls_key_packages',
            'mls_add_members',
            'mls_clear_pending_commit',
            'mls_commit_pending_proposals',
            'mls_create_group',
            'mls_delete_group',
            'mls_drain_pending_messages',
            'mls_generate_key_packages_with_handle',
            'mls_import_backup',
            'mls_import_state',
            'mls_join_group',
            'mls_leave_group',
            'mls_merge_pending_commit',
            'mls_process_message',
            'mls_rejoin_group',
            'mls_remove_members',
            'mls_send_message',
        ]);
    });

    it('excludes the commands that only read, and the one that deletes instead of writing', () => {
        for (const command of [
            'mls_load_signing_key',
            'mls_unload_signing_key',
            'mls_export_state',
            'mls_export_backup',
            'mls_get_members',
            'mls_get_group_info',
            'mls_export_group_info',
            'mls_signing_key_fingerprint',
            'mls_inspect_key_package',
            'mls_init_storage',
            'mls_clear_storage',
        ]) {
            expect(MLS_MUTATING_COMMANDS.has(command), command).toBe(false);
        }
    });
});
