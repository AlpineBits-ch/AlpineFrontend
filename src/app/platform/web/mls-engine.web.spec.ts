import {IDBFactory as FakeIdbFactory} from 'fake-indexeddb';
import {beforeEach, describe, expect, it} from 'vitest';

import {
    MLS_MUTATING_COMMANDS,
    MlsStateNotPersistedError,
    MlsStateUnreadableError,
    WebMlsEngine,
} from './mls-engine.web';
import {IdbStore, openStore} from './idb';
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
            throw 'MlsError: no state key was supplied - mls_state.json cannot be written unsealed, so '
            + 'encryption stays unavailable until the keychain produces one';
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
let module: FakeEngineModule;
let engine: WebMlsEngine;

/** Opens the adapter's store the way the adapter itself would, against the test's factory. */
function open(): Promise<IdbStore> {
    return openStore(DB_NAME, STORE_NAME, {factory});
}

/**
 * A page load: a new engine, a new module, the same storage.
 *
 * <p>This is the whole harness. Every assertion about persistence has to survive one of these, because
 * anything that only survives inside one is exactly the bug.</p>
 */
function reload(): void {
    module = new FakeEngineModule();
    engine = new WebMlsEngine(async () => module, open);
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
        await expect(engine.call('mls_get_group_info', {groupIdB64: 'YWNjb3VudEE='}))
            .rejects.toBe('GroupNotFound: group not found');
    });

    it('refuses a mutation before initStorage, rather than performing an unpersistable one', async () => {
        // Native's `save_to_disk` with no `state_path` is an error, not a no-op, for exactly this
        // reason: it used to return `Ok(())`, and every group an uninitialised engine joined vanished
        // on the next launch with nothing saying so.
        await expect(engine.call('mls_create_group', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h'}))
            .rejects.toThrow(/MLS storage is not initialised/);
    });

    it('recovers from that on the next initStorage, because import replaces rather than merges', async () => {
        await engine.call('mls_create_group', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h'})
            .catch(() => undefined);

        // Not latched, unlike a failed write: the ordering fault fixes itself, and refusing forever
        // would take the page down for something recoverable.
        await engine.call('mls_init_storage', initArgs());
        await expect(engine.call('mls_create_group', {groupIdB64: 'Z3JvdXAy', keyHandle: 'h'}))
            .resolves.toBeTruthy();
    });

    it('refuses the state key being absent, in the engine own words', async () => {
        // Not paraphrased and not wrapped: `mls.service.ts`'s classifier is meant to tell a transient
        // key-store failure from a corrupt state file, and only the second wipes a device's groups.
        await expect(engine.call('mls_init_storage', {scope: DEVICE_A, adoptLegacy: false}))
            .rejects.toMatch(/no state key was supplied/);
    });
});

describe('WebMlsEngine when the state cannot be written', () => {
    beforeEach(async () => {
        await engine.call('mls_init_storage', initArgs());
        await engine.call('mls_create_group', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h'});
    });

    it('refuses the operation rather than reporting a success that will not survive', async () => {
        module.exportError = 'MlsError: could not seal the state';

        await expect(engine.call('mls_send_message', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h', plaintextB64: 'aGk='}))
            .rejects.toBeInstanceOf(MlsStateNotPersistedError);
    });

    it('latches, so nothing piles more unpersisted work onto a diverged engine', async () => {
        module.exportError = 'MlsError: could not seal the state';
        await expect(engine.call('mls_send_message', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h', plaintextB64: 'aGk='}))
            .rejects.toBeInstanceOf(MlsStateNotPersistedError);

        // Even with the fault gone: a mixture of persisted and unpersisted operations is the one state
        // a reload cannot repair, so the refusal stands until the page is reloaded.
        module.exportError = undefined;
        module.calls.length = 0;
        await expect(engine.call('mls_create_group', {groupIdB64: 'Z3JvdXAy', keyHandle: 'h'}))
            .rejects.toBeInstanceOf(MlsStateNotPersistedError);
        expect(module.calls).toEqual([]);
    });

    it('keeps answering reads, which cannot deepen the divergence', async () => {
        module.exportError = 'MlsError: could not seal the state';
        await expect(engine.call('mls_send_message', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h', plaintextB64: 'aGk='}))
            .rejects.toBeInstanceOf(MlsStateNotPersistedError);

        await expect(engine.call('mls_get_group_info', {groupIdB64: 'Z3JvdXAx'})).resolves.toBeTruthy();
    });

    it('rolls back to the last durable state on the reload it asks for', async () => {
        module.exportError = 'MlsError: could not seal the state';
        await engine.call('mls_send_message', {groupIdB64: 'Z3JvdXAx', keyHandle: 'h', plaintextB64: 'aGk='})
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
        module = new FakeEngineModule();
        engine = new WebMlsEngine(async () => module, () => storeWith({
            get: async () => { throw new Error('the database is blocked'); },
        }));
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

        await expect(engine.call('mls_create_group', {groupIdB64: 'Z3JvdXAy', keyHandle: 'h'}))
            .rejects.toBeInstanceOf(MlsStateUnreadableError);
    });

    it('leaves the blob intact, so the next load can still recover it', async () => {
        reloadWithUnreadableStore();
        await engine.call('mls_init_storage', initArgs());
        await engine.call('mls_create_group', {groupIdB64: 'Z3JvdXAy', keyHandle: 'h'}).catch(() => undefined);
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
        await engine.call('mls_init_storage', initArgs());
        const broken = new WebMlsEngine(async () => module, () => storeWith({
            delete: async () => { throw new Error('the database is read-only'); },
        }));
        await broken.call('mls_init_storage', initArgs());

        // A wipe that did not wipe leaves this account's key material for whoever uses the browser
        // next, so it must not resolve.
        await expect(broken.call('mls_clear_storage')).rejects.toBeInstanceOf(MlsStateNotPersistedError);
    });
});

describe('WebMlsEngine availability', () => {
    it('is available once the module has loaded', async () => {
        await engine.ready();
        expect(engine.available).toBe(true);
    });

    it('reports a module that failed to load, and refuses every call loudly', async () => {
        const broken = new WebMlsEngine(async () => { throw new Error('chunk load failed'); }, open);

        await expect(broken.ready()).rejects.toThrow(/chunk load failed/);
        expect(broken.available).toBe(false);
        // Not a resolved value and not a silent no-op: "it crashes earlier" is not an access control,
        // and reporting success for an operation that never happened is the failure being avoided.
        await expect(broken.call('mls_get_group_info', {groupIdB64: 'Z3JvdXAx'}))
            .rejects.toThrow(/chunk load failed/);
    });

    it('is optimistic before the load resolves, which the encryption floor depends on', async () => {
        // `MlsService.readRegistry` answers "nothing recorded here" when the engine is unavailable, and
        // that answer for `#floor` permits cleartext. Reading "still loading" as unavailable would make
        // the first second of every boot a §L.9 downgrade window.
        const slow = new WebMlsEngine(() => new Promise(() => undefined), open);
        expect(slow.available).toBe(true);
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
            'mls_load_signing_key', 'mls_unload_signing_key', 'mls_export_state', 'mls_export_backup',
            'mls_get_members', 'mls_get_group_info', 'mls_export_group_info',
            'mls_signing_key_fingerprint', 'mls_inspect_key_package',
            'mls_init_storage', 'mls_clear_storage',
        ]) {
            expect(MLS_MUTATING_COMMANDS.has(command), command).toBe(false);
        }
    });
});
