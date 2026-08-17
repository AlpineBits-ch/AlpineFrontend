import {IDBFactory as FakeIdbFactory} from 'fake-indexeddb';
import {beforeEach, describe, expect, it} from 'vitest';

import {MlsLocalStore} from '../ports/mls-local-store.port';
import {FakeLockManager} from '../testing/fake-lock-manager';
import {IdbStore, openStore} from './idb';
import {WebMlsLocalStoreFactory} from './mls-local-store.web';

/**
 * MLS's two per-account local files in a browser, and the one thing about them that is a security
 * property rather than a storage detail.
 *
 * <p><b>What this file is about.</b> The single-session guard in `mls-engine.web.ts` owns the
 * <i>engine</i>: one live `MlsState` per account per profile, one writer of `state::${scope}`. It says
 * nothing about these two IndexedDB files, and both are still written by every tab. The entry that
 * matters is `ctx#floor`, the monotonic encryption floor: a non-null value means "this device has
 * encrypted this context", and it is the only thing standing between a server that says a conversation
 * is plaintext and a client that composes into it in the clear (§L.9). A floor that reads absent, or
 * reads lower than it is, is that downgrade.</p>
 *
 * <p>Two tabs could produce both. The mirror each store keeps was loaded once and never revalidated, so
 * one tab never saw the other's writes for the rest of its life; and `raiseEncryptionFloor` is a
 * read-modify-write, so two tabs interleaved wrote the <i>lower</i> generation last. Neither is visible
 * to the user and neither needs a bug anywhere else to happen.</p>
 *
 * <p>So every test below runs <b>two factories against one {@link FakeLockManager} and one
 * IndexedDB</b>: the shared manager and the shared database are the browser profile, and giving each
 * tab its own would make all of this pass vacuously. Driven by `fake-indexeddb`, a real implementation
 * of the spec, so transactions and structured clone behave as they do in a browser.</p>
 */

const DB_NAME = 'alpine-mls-stores';
const STORE_NAME = 'entries';
const REGISTRY = 'mls-group-registry-device-a.json';
const CACHE = 'mls-message-cache-device-a.json';
const FLOOR = 'ctx-1#floor';

/** One browser profile's storage and lock manager, shared by every "tab" a test opens. */
let factory: IDBFactory;
let profile: FakeLockManager;

/** Every store this test opened, closed afterwards so a connection does not block the next database. */
let opened: IdbStore[] = [];

beforeEach(() => {
    factory = new FakeIdbFactory();
    profile = new FakeLockManager();
    opened = [];
});

/**
 * One store with some operations replaced.
 *
 * <p>Delegating explicitly rather than spreading the store, for the reason `mls-engine.web.spec.ts`
 * gives: `openStore` returns a class instance and `{...store}` copies none of its prototype methods,
 * which presents not as an empty object but as whichever unrelated failure the first missing method
 * produces.</p>
 */
async function storeWith(hook?: (real: IdbStore) => Partial<IdbStore>): Promise<IdbStore> {
    const real = await openStore(DB_NAME, STORE_NAME, {factory});
    opened.push(real);
    return {
        dbName: real.dbName,
        storeName: real.storeName,
        get: key => real.get(key),
        set: (key, value) => real.set(key, value),
        delete: key => real.delete(key),
        keys: () => real.keys(),
        clear: () => real.clear(),
        close: () => real.close(),
        ...(hook?.(real) ?? {}),
    };
}

/** One tab of this profile: its own stores, the profile's database and lock manager. */
function openTab(hook?: (real: IdbStore) => Partial<IdbStore>): WebMlsLocalStoreFactory {
    return new WebMlsLocalStoreFactory(profile, () => storeWith(hook));
}

/** A read from a tab that has never looked at the file before, so no mirror can be answering. */
function freshRead<T>(file: string, key: string): Promise<T | undefined> {
    return openTab().open(file).get<T>(key);
}

/**
 * A tab whose <b>first</b> write stalls until the gate is opened, reporting when it gets there.
 *
 * <p>This is the interleaving harness, and it has to be a stall rather than a scheduling coincidence:
 * two updates started at the same instant may or may not overlap, so a test written that way passes on
 * the broken code whenever the runtime happens to serialise them. Stalling one tab after it has read
 * and decided, but before it has written, makes the overlap the only thing that can happen.</p>
 */
function blockedOnFirstWrite(): {
    tab: WebMlsLocalStoreFactory;
    deciding: Promise<void>;
    release: () => void;
} {
    let arrive!: () => void;
    let release!: () => void;
    const deciding = new Promise<void>(resolve => {
        arrive = resolve;
    });
    const held = new Promise<void>(resolve => {
        release = resolve;
    });

    let stalled = false;
    const tab = openTab(real => ({
        set: async (key, value) => {
            if (!stalled) {
                stalled = true;
                arrive();
                await held;
            }
            await real.set(key, value);
        },
    }));
    return {tab, deciding, release};
}

/** Real time, because `fake-indexeddb` schedules across tasks and not only microtasks. */
function tick(ms = 50): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('IdbMlsLocalStore across two tabs of one profile', () => {
    it('reads a value the other tab wrote after this one had already read the file', async () => {
        const first = openTab().open(REGISTRY);
        const second = openTab().open(REGISTRY);
        // Builds the second tab's mirror while the file is still empty. Everything depends on this
        // having happened: a tab that only ever reads after the other tab's write reads it by accident.
        expect(await second.get(FLOOR)).toBeUndefined();

        await first.set(FLOOR, 5);

        // The floor is the entry this matters for. `undefined` here means "this context was never
        // encrypted on this device", which is the answer that licenses composing cleartext into a
        // conversation the other tab is encrypting.
        expect(await second.get<number>(FLOOR)).toBe(5);
    });

    it('reads a deletion the other tab performed', async () => {
        const first = openTab().open(REGISTRY);
        const second = openTab().open(REGISTRY);
        await first.set('ctx-1#active', 4);
        expect(await second.get<number>('ctx-1#active')).toBe(4);

        await first.delete('ctx-1#active');

        expect(await second.get('ctx-1#active')).toBeUndefined();
    });

    it('enumerates the other tab writes, which is what an export and a merge read', async () => {
        const first = openTab().open(REGISTRY);
        const second = openTab().open(REGISTRY);
        await second.entries();

        await first.set(FLOOR, 2);
        await first.set('ctx-1#active', 2);

        expect(new Map(await second.entries<number>())).toEqual(
            new Map([[FLOOR, 2], ['ctx-1#active', 2]]),
        );
    });

    it('reports a wipe the other tab performed rather than serving what it deleted', async () => {
        const first = openTab().open(REGISTRY);
        const second = openTab().open(REGISTRY);
        await first.set(FLOOR, 3);
        expect(await second.get<number>(FLOOR)).toBe(3);

        await first.clear();

        expect(await second.entries()).toEqual([]);
    });

    it('keeps the two files apart, so clearing the cache cannot drop the registry', async () => {
        const tab = openTab();
        const registry = tab.open(REGISTRY);
        const cache = tab.open(CACHE);
        await registry.set(FLOOR, 6);
        await cache.set('ctx-1#0#msg-1', {v: 1, at: 1, iv: 'aXY=', ct: 'Y3Q='});

        await cache.clear();

        // Losing the registry makes every restored group unaddressable and reads as "never encrypted",
        // which is the §L.9 downgrade the floor exists to refuse.
        expect(await freshRead<number>(REGISTRY, FLOOR)).toBe(6);
        expect(await freshRead(CACHE, 'ctx-1#0#msg-1')).toBeUndefined();
    });
});

/**
 * The read-modify-write, which is the part a per-key write cannot give.
 *
 * <p>Every assertion here is on <b>what is stored afterwards</b>, read from a tab that has never seen
 * the file. Asserting that a lock was requested would prove nothing: the question is whether the floor
 * can end up below a generation this device has already encrypted at.</p>
 */
describe('IdbMlsLocalStore.update', () => {
    /** How `MlsService.raiseEncryptionFloor` calls it. Monotonic by construction, or not at all. */
    const raiseTo = (generation: number) => (current: number | undefined) =>
        current !== undefined && current >= generation ? current : generation;

    it('never lets the floor go backwards when the two tabs overlap', async () => {
        const lower = blockedOnFirstWrite();
        const higher = openTab().open(REGISTRY);

        // Reads the empty file, decides 3, and stalls before writing a byte of it.
        const lowerRaise = lower.tab.open(REGISTRY).update<number>(FLOOR, raiseTo(3));
        await lower.deciding;

        // The other tab now raises the floor to 5. Unserialised it runs to completion here, and the
        // stalled write lands on top of it - the lower generation written last, which is the floor
        // going backwards and cleartext permitted at generations 4 and 5.
        const higherRaise = higher.update<number>(FLOOR, raiseTo(5));
        await tick();
        lower.release();
        await Promise.all([lowerRaise, higherRaise]);

        expect(await freshRead<number>(REGISTRY, FLOOR)).toBe(5);
    });

    it('tells the losing caller the floor that is actually in force', async () => {
        const higher = blockedOnFirstWrite();
        const lower = openTab().open(REGISTRY);

        // This time the *higher* raise decides first and stalls, so the lower one runs against a file
        // that already has 5 in it as far as any serialised view is concerned.
        const higherRaise = higher.tab.open(REGISTRY).update<number>(FLOOR, raiseTo(5));
        await higher.deciding;
        const lowerRaise = lower.update<number>(FLOOR, raiseTo(3));
        await tick();
        higher.release();
        await Promise.all([higherRaise, lowerRaise]);

        // Both callers must be told 5. Answering the second one "3" is its own downgrade even when
        // storage ends up right: `registerGroup` reports that raise as done, and a caller that believes
        // the floor is 3 will compose in the clear at generation 4.
        await expect(higherRaise).resolves.toBe(5);
        await expect(lowerRaise).resolves.toBe(5);
        expect(await freshRead<number>(REGISTRY, FLOOR)).toBe(5);
    });

    it('decides from storage rather than from a mirror the other tab has moved past', async () => {
        const first = openTab().open(REGISTRY);
        const second = openTab().open(REGISTRY);
        // The second tab's mirror is built while the file is empty, and then the first tab raises.
        expect(await second.get(FLOOR)).toBeUndefined();
        await first.set(FLOOR, 9);

        await second.update<number>(FLOOR, raiseTo(4));

        expect(await freshRead<number>(REGISTRY, FLOOR)).toBe(9);
    });

    it('writes nothing when the callback returns what it was given', async () => {
        let writes = 0;
        const counting = openTab(real => ({
            set: async (key, value) => {
                writes++;
                await real.set(key, value);
            },
        })).open(REGISTRY);
        await counting.set(FLOOR, 7);
        writes = 0;

        await expect(counting.update<number>(FLOOR, raiseTo(2))).resolves.toBe(7);

        // Both the value and the revision marker would be written by a naive implementation, and the
        // revision is the expensive half: every other tab reloads the whole file for a no-op.
        expect(writes).toBe(0);
    });

    it('removes the entry when the callback returns undefined', async () => {
        const store = openTab().open(REGISTRY);
        await store.set(FLOOR, 7);

        await expect(store.update<number>(FLOOR, () => undefined)).resolves.toBeUndefined();

        expect(await freshRead(REGISTRY, FLOOR)).toBeUndefined();
    });

    it('leaves the entry untouched when the callback throws', async () => {
        const store = openTab().open(REGISTRY);
        await store.set(FLOOR, 7);

        await expect(store.update<number>(FLOOR, () => {
            throw new Error('the key store could not be read');
        })).rejects.toThrow(/could not be read/);

        expect(await freshRead<number>(REGISTRY, FLOOR)).toBe(7);
    });

    it('releases the file after a throw, so the next caller is not locked out', async () => {
        const store = openTab().open(REGISTRY);

        await store.update(FLOOR, () => {
            throw new Error('boom');
        }).catch(() => undefined);

        // A critical section that leaked on the error path would deadlock every later read of this
        // file, in every tab, for as long as the page stays open.
        await expect(store.update<number>(FLOOR, raiseTo(1))).resolves.toBe(1);
    });

    it('does not hold up the other file while one is being written', async () => {
        const stalled = blockedOnFirstWrite();
        const cacheWrite = stalled.tab.open(CACHE).set('ctx-1#0#msg-1', 'aGk=');
        await stalled.deciding;

        // A lock per database rather than per file would make pruning the message cache - thousands of
        // entries, on the path that renders a conversation - block every floor read behind it.
        await expect(openTab().open(REGISTRY).get(FLOOR)).resolves.toBeUndefined();

        stalled.release();
        await cacheWrite;
    });
});

describe('IdbMlsLocalStore without a Web Locks API', () => {
    /** An older browser, or an insecure origin. `detectLockManager` answers undefined there. */
    const unguarded = () => new WebMlsLocalStoreFactory(undefined, () => storeWith());

    it('still reads and writes, rather than taking the whole client down with it', async () => {
        // Failing closed here would cost the reads that report the refusal and the wipe a sign-out
        // performs, and buy nothing: `WebMlsEngine` refuses every command on such a host, so no group
        // is created and no floor is ever raised.
        const store = unguarded().open(REGISTRY);

        await store.set(FLOOR, 4);

        expect(await store.get<number>(FLOOR)).toBe(4);
        await expect(store.update<number>(FLOOR, current => (current ?? 0) + 1)).resolves.toBe(5);
    });
});

describe('IdbMlsLocalStore basics', () => {
    let store: MlsLocalStore;

    beforeEach(() => {
        store = openTab().open(REGISTRY);
    });

    it('round-trips a value and reports an absent key as undefined', async () => {
        await store.set('ctx-1#2', 'Z3JvdXA=');

        expect(await store.get<string>('ctx-1#2')).toBe('Z3JvdXA=');
        expect(await store.get('ctx-1#3')).toBeUndefined();
    });

    it('reports whether a delete removed anything', async () => {
        await store.set(FLOOR, 1);

        await expect(store.delete(FLOOR)).resolves.toBe(true);
        await expect(store.delete(FLOOR)).resolves.toBe(false);
    });

    it('survives a reload, because nothing here is buffered', async () => {
        await store.set(FLOOR, 8);
        await store.save();

        expect(await freshRead<number>(REGISTRY, FLOOR)).toBe(8);
    });
});
