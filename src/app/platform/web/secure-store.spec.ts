import {IDBFactory as FakeIdbFactory} from 'fake-indexeddb';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {IdbStore, IdbUnavailableError, openStore} from './idb';
import {WebSecureStore} from './secure-store';

/**
 * The browser {@link SecureStore}, against a real IndexedDB implementation.
 *
 * <p><b>What matters here is the failure behaviour, not the round trip.</b> This adapter holds the MLS
 * signing keys and the wrapped account master key, and the one thing it must never do is report a
 * write as done when nothing was persisted - a caller that has just generated a master key would hand
 * the user a recovery that cannot work. So the tests that carry weight are the ones asserting that an
 * absent IndexedDB rejects, and that nothing lands in `localStorage` when it does.</p>
 *
 * <p>Driven by <b>fake-indexeddb</b> for the same reason `idb.spec.ts` is: jsdom ships no IndexedDB.
 * The adapter deliberately has no injection seam for the factory - it reads `globalThis.indexedDB`,
 * which is what a browser gives it - so these tests install and remove that global instead, which
 * exercises the real resolution path.</p>
 */

const DB_NAME = 'alpine-secure-store';
const STORE_NAME = 'entries';

/** `localStorage`, watched rather than used: the point is that nothing here ever writes to it. */
const localStore = new Map<string, string>();

let siblings: IdbStore[] = [];

beforeEach(() => {
    localStore.clear();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => localStore.get(k) ?? null,
            setItem: (k: string, v: string) => void localStore.set(k, String(v)),
            removeItem: (k: string) => void localStore.delete(k),
            clear: () => localStore.clear(),
        },
    });
    installIndexedDb();
});

afterEach(() => {
    for (const store of siblings) {
        try {
            store.close();
        } catch {
            // Already closed.
        }
    }
    siblings = [];
    removeIndexedDb();
});

function installIndexedDb(): void {
    Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: new FakeIdbFactory(),
    });
}

function removeIndexedDb(): void {
    delete (globalThis as Record<string, unknown>)['indexedDB'];
}

/** A second view of the same object store, for writing what "something else wrote it" means. */
async function sibling(): Promise<IdbStore> {
    const store = await openStore(DB_NAME, STORE_NAME);
    siblings.push(store);
    return store;
}

describe('WebSecureStore', () => {
    it('round-trips a value and reports an absent key as null', async () => {
        const store = new WebSecureStore();

        await store.setItem('alpine_mls_device-a_priv', 'seed-bytes');

        expect(await store.getItem('alpine_mls_device-a_priv')).toBe('seed-bytes');
        expect(await store.getItem('alpine_mls_device-b_priv')).toBeNull();
    });

    it('distinguishes a stored empty string from an absent key', async () => {
        const store = new WebSecureStore();

        await store.setItem('empty', '');

        // `MlsService` treats a falsy value as "no key" and mints one; that is its choice to make,
        // and it can only make it if the store does not conflate the two.
        expect(await store.getItem('empty')).toBe('');
        expect(await store.getItem('never-written')).toBeNull();
    });

    it('removes a key, and removing an absent one is not an error', async () => {
        const store = new WebSecureStore();
        await store.setItem('k', 'v');

        await store.removeItem('k');
        await expect(store.removeItem('k')).resolves.toBeUndefined();

        expect(await store.getItem('k')).toBeNull();
    });

    it('persists across adapter instances, which is the whole point of it', async () => {
        await new WebSecureStore().setItem('alpine_mls_device-a_pub', 'public-key');

        // A second instance is a second boot: same database, same object store, same bytes.
        expect(await new WebSecureStore().getItem('alpine_mls_device-a_pub')).toBe('public-key');
    });

    it('reports that it is not hardware-backed', () => {
        // The one flag the key-backup UI reads to avoid claiming a protection this host cannot give.
        expect(new WebSecureStore().hardwareBacked).toBe(false);
    });

    // ── The failure that matters ─────────────────────────────────────────────

    it('rejects a write when there is no IndexedDB, rather than storing it anywhere else',
        async () => {
            removeIndexedDb();
            const store = new WebSecureStore();

            await expect(store.setItem('master_key', 'wrapped-master-key'))
                .rejects.toThrow(IdbUnavailableError);

            // The assertion this file exists for: no silent downgrade. A `localStorage` fallback
            // would have made the write "succeed" into storage the design refuses to put key
            // material in, and a caller cannot tell the difference from the return value alone.
            expect([...localStore.keys()]).toEqual([]);
        });

    it('rejects a read when there is no IndexedDB, rather than answering "no key"', async () => {
        removeIndexedDb();
        const store = new WebSecureStore();

        // Answering null here would be the worse bug of the two: `MlsService` reads a missing
        // signing key as "this device needs a fresh identity", which orphans it from every group
        // it belongs to while the key is still sitting in a database this build could not open.
        await expect(store.getItem('alpine_mls_device-a_priv'))
            .rejects.toThrow(IdbUnavailableError);
    });

    it('does not remember an open failure, so one bad boot is not a dead session', async () => {
        removeIndexedDb();
        const store = new WebSecureStore();
        await expect(store.getItem('k')).rejects.toThrow(IdbUnavailableError);

        installIndexedDb();

        // `blocked` (another tab holding an upgrade) and `quota` are transient in exactly this way.
        // A memoised rejection would turn the first unlucky call into a session that can never read
        // or write a key again.
        await store.setItem('k', 'v');
        expect(await store.getItem('k')).toBe('v');
    });

    it('refuses to hand back a value another component wrote as binary', async () => {
        await (await sibling()).set('alpine_mls_device-a_priv', new Uint8Array([1, 2, 3]));

        // Only strings are written here. Coercing three bytes into a "key" would present as a
        // signing key that is silently the wrong one; saying so is the only honest answer.
        await expect(new WebSecureStore().getItem('alpine_mls_device-a_priv'))
            .rejects.toThrow(/binary/);
    });

    it('does not close, or get closed by, the MLS engine\'s own database', async () => {
        // What the WASM MLS engine will hold: its exported state blob, in a database of its own.
        // The two must not interact, and the reason they would have is not obvious: adding an object
        // store to an existing database is a version change, and `idb.ts` yields to one by closing
        // the connection it is holding. Sharing a database name therefore means that on the first
        // run, whichever component opened first is closed by the second - while believing its last
        // write landed. This test is what pins the two names apart.
        const engineState = await openStore('alpine-mls', 'state');
        siblings.push(engineState);
        await engineState.set('blob', new Uint8Array([9, 9]));

        const store = new WebSecureStore();
        await store.setItem('alpine_mls_device-a_priv', 'seed-bytes');

        expect(await store.getItem('alpine_mls_device-a_priv')).toBe('seed-bytes');
        expect(await engineState.get('blob')).toEqual(new Uint8Array([9, 9]));
    });

    it('recovers from another tab upgrading the database, rather than going dead', async () => {
        const store = new WebSecureStore();
        await store.setItem('alpine_mls_device-a_priv', 'seed-bytes');

        // What a second tab on a future build does: bump the version to add a store. The connection
        // this adapter holds yields and is marked unusable, and every later call on it would reject
        // with `IdbStoreClosedError` if it did not reopen.
        siblings.push(await openStore(DB_NAME, 'added-later'));

        expect(await store.getItem('alpine_mls_device-a_priv')).toBe('seed-bytes');
        await expect(store.setItem('k', 'v')).resolves.toBeUndefined();
    });
});
