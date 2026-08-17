import {IDBFactory as FakeIdbFactory} from 'fake-indexeddb';
import {afterEach, describe, expect, it} from 'vitest';

import {
    classifyIdbError,
    IdbBlockedError,
    IdbCorruptValueError,
    IdbStore,
    IdbStoreClosedError,
    IdbTransactionAbortedError,
    IdbUnavailableError,
    IdbVersionError,
    isIndexedDbAvailable,
    openStore,
    runRequest,
} from './idb';

/**
 * These tests run against <b>fake-indexeddb</b>, a pure-JS implementation of the IndexedDB spec
 * (derived from the W3C web-platform-tests), because jsdom ships no IndexedDB at all. It is a real
 * implementation, not a stub of this module's logic: transactions, structured clone, version
 * changes, {@code blocked} and {@code abort} all behave as specified, so the wiring in
 * {@code idb.ts} is genuinely exercised.
 *
 * <p><b>Not covered here</b>, and covered nowhere but a real browser:</p>
 * <ul>
 *   <li>Actual quota exhaustion. fake-indexeddb has no quota, so the {@code QuotaExceededError}
 *       mapping is tested by handing {@link classifyIdbError} a real {@code DOMException} - the
 *       classification is verified, the pressure that produces it is not.</li>
 *   <li>Engine-specific private-browsing behaviour (Safari/Firefox refusing {@code open}). The
 *       synchronous-throw path is covered by a throwing factory; which engines take it is not.</li>
 *   <li>Persistence across page loads, eviction, and {@code navigator.storage.persist()}.</li>
 * </ul>
 *
 * <p>One harness artifact worth knowing: this environment's structured clone runs outside the jsdom
 * realm, so values read back are cross-realm. That is why {@code get} rebuilds binary values in the
 * caller's realm, and it makes the {@code instanceof} assertions below stricter here than they would
 * be in a browser rather than weaker.</p>
 *
 * <p>Every test gets a fresh {@code new FakeIdbFactory()}, so no database state leaks between
 * tests, and {@code globalThis.indexedDB} is deliberately left undefined - that absence is itself
 * asserted by the "unavailable" tests.</p>
 */

const newFactory = (): IDBFactory => new FakeIdbFactory();

let openStores: IdbStore[] = [];
let openConnections: IDBDatabase[] = [];

const openTracked = async (
    factory: IDBFactory,
    dbName = 'test-db',
    storeName = 'kv',
    options: {version?: number; blockedTimeoutMs?: number} = {},
): Promise<IdbStore> => {
    const store = await openStore(dbName, storeName, {factory, ...options});
    openStores.push(store);
    return store;
};

afterEach(() => {
    for (const store of openStores) {
        try {
            store.close();
        } catch {
            // Already closed by the test.
        }
    }
    for (const connection of openConnections) {
        try {
            connection.close();
        } catch {
            // Already closed by the test.
        }
    }
    openStores = [];
    openConnections = [];
});

/** Opens a raw connection that, unlike {@link openStore}, does <b>not</b> yield on versionchange. */
const rawOpen = (
    factory: IDBFactory,
    dbName: string,
    version: number,
    storeName?: string,
): Promise<IDBDatabase> =>
    new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(dbName, version);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (storeName !== undefined && !db.objectStoreNames.contains(storeName)) {
                db.createObjectStore(storeName);
            }
        };
        request.onsuccess = () => {
            openConnections.push(request.result);
            resolve(request.result);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error(`raw open of "${dbName}" v${version} was blocked`));
    });

/** Fails loudly instead of letting the suite time out, so "it hung" reads as "it hung". */
const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        promise.finally(() => {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        }),
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
        }),
    ]);
};

const bytes = (value: unknown): number[] => {
    if (value instanceof Uint8Array) {
        return Array.from(value);
    }
    throw new Error(`expected a Uint8Array, got ${Object.prototype.toString.call(value)}`);
};

describe('openStore - binary round trip', () => {
    it('returns a Uint8Array byte-identical to the one written, including 0x00, 0xFF and invalid UTF-8', async () => {
        // 0xC3 0x28 and a lone 0x80 are both invalid UTF-8. Guard the fixture itself: if these
        // bytes survived a text round trip, this test could not catch a string coercion.
        const original = new Uint8Array([0x00, 0xff, 0xfe, 0xc3, 0x28, 0x80, 0x7f, 0x01, 0xff, 0x00]);
        const throughText = new TextEncoder().encode(new TextDecoder().decode(original));
        expect(Array.from(throughText)).not.toEqual(Array.from(original));

        const store = await openTracked(newFactory());
        await store.set('mls-state', original);
        const read = await store.get('mls-state');

        expect(read).toBeInstanceOf(Uint8Array);
        expect(typeof read).not.toBe('string');
        expect(bytes(read)).toEqual([0x00, 0xff, 0xfe, 0xc3, 0x28, 0x80, 0x7f, 0x01, 0xff, 0x00]);
        expect((read as Uint8Array).byteLength).toBe(original.byteLength);
    });

    it("stores a copy, so mutating the caller's array afterwards does not change what was stored", async () => {
        const store = await openTracked(newFactory());
        const source = new Uint8Array([1, 2, 3, 4]);
        await store.set('k', source);

        source[0] = 0xff;
        source[3] = 0xff;

        expect(bytes(await store.get('k'))).toEqual([1, 2, 3, 4]);
    });

    it('round-trips a blob the size of a real MLS state export without truncation', async () => {
        // Deterministic pseudo-random fill: a base64 or latin1 detour mangles high bytes, and a
        // truncation shows up as a length mismatch.
        const blob = new Uint8Array(64 * 1024);
        let seed = 0x12345678;
        for (let i = 0; i < blob.length; i++) {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            blob[i] = seed & 0xff;
        }

        const store = await openTracked(newFactory());
        await store.set('mls-state', blob);
        const read = await store.get('mls-state');

        expect(read).toBeInstanceOf(Uint8Array);
        expect((read as Uint8Array).byteLength).toBe(blob.length);
        expect(bytes(read)).toEqual(Array.from(blob));
    });

    it("round-trips a Uint8Array view onto a larger buffer as just the view's bytes", async () => {
        const backing = new Uint8Array([0xaa, 0xbb, 0x01, 0x02, 0x03, 0xcc]);
        const view = backing.subarray(2, 5);

        const store = await openTracked(newFactory());
        await store.set('view', view);
        const read = await store.get('view');

        expect(read).toBeInstanceOf(Uint8Array);
        expect(bytes(read)).toEqual([0x01, 0x02, 0x03]);
    });

    it('keeps an ArrayBuffer an ArrayBuffer with the same bytes', async () => {
        const buffer = new Uint8Array([0x00, 0xff, 0x10]).buffer;

        const store = await openTracked(newFactory());
        await store.set('buf', buffer);
        const read = await store.get('buf');

        expect(read).toBeInstanceOf(ArrayBuffer);
        expect(Array.from(new Uint8Array(read as ArrayBuffer))).toEqual([0x00, 0xff, 0x10]);
    });

    it("returns binary belonging to the caller's own realm, so instanceof holds", async () => {
        // This harness's structured clone runs outside the jsdom realm, so a value read straight
        // out of IndexedDB here is a Uint8Array that fails `instanceof Uint8Array`. Passing that
        // through would make the declared return type a half-truth, and it is the same shape as a
        // value arriving from a worker or an iframe in production.
        const store = await openTracked(newFactory());
        await store.set('k', new Uint8Array([1, 2, 3]));

        const read = await store.get('k');

        expect(read instanceof Uint8Array).toBe(true);
        expect(Object.getPrototypeOf(read)).toBe(Uint8Array.prototype);
    });

    it('does not confuse a string value with binary bytes of the same content', async () => {
        const store = await openTracked(newFactory());
        await store.set('text', 'AB');
        await store.set('binary', new Uint8Array([0x41, 0x42]));

        expect(await store.get('text')).toBe('AB');
        expect(await store.get('binary')).toBeInstanceOf(Uint8Array);
        expect(bytes(await store.get('binary'))).toEqual([0x41, 0x42]);
    });
});

describe('openStore - string round trip', () => {
    it('round-trips ordinary, empty and non-BMP strings', async () => {
        const store = await openTracked(newFactory());
        const cases: Record<string, string> = {
            plain: 'a signing key',
            empty: '',
            unicode: 'schlüssel \u{1f511}\u{1f512} 中文',
            json: '{"kind":"masterKey","wrapped":"AAAA"}',
            newlines: 'line1\nline2\r\n\ttabbed',
        };

        for (const [key, value] of Object.entries(cases)) {
            await store.set(key, value);
        }
        for (const [key, value] of Object.entries(cases)) {
            expect(await store.get(key)).toBe(value);
        }
    });

    it('distinguishes a missing key from a stored empty string', async () => {
        const store = await openTracked(newFactory());
        await store.set('present-but-empty', '');

        expect(await store.get('present-but-empty')).toBe('');
        expect(await store.get('never-written')).toBeUndefined();
        // The distinction has to survive at the key level too, not just the value level.
        expect(await store.keys()).toEqual(['present-but-empty']);
    });

    it('distinguishes a missing key from a stored empty Uint8Array', async () => {
        const store = await openTracked(newFactory());
        await store.set('empty-bytes', new Uint8Array(0));

        const read = await store.get('empty-bytes');
        expect(read).toBeInstanceOf(Uint8Array);
        expect((read as Uint8Array).byteLength).toBe(0);
        expect(await store.get('absent')).toBeUndefined();
    });

    it('overwrites an existing value rather than appending', async () => {
        const store = await openTracked(newFactory());
        await store.set('k', 'first');
        await store.set('k', 'second');

        expect(await store.get('k')).toBe('second');
        expect(await store.keys()).toEqual(['k']);
    });
});

describe('openStore - delete, keys and clear', () => {
    it('delete removes the value, and a later get reports absence rather than the old value', async () => {
        const store = await openTracked(newFactory());
        await store.set('doomed', new Uint8Array([9, 9, 9]));
        expect(await store.get('doomed')).toBeInstanceOf(Uint8Array);

        await store.delete('doomed');

        expect(await store.get('doomed')).toBeUndefined();
        expect(await store.keys()).toEqual([]);
    });

    it('delete of an absent key resolves without error and touches nothing else', async () => {
        const store = await openTracked(newFactory());
        await store.set('keep', 'me');

        await expect(store.delete('never-existed')).resolves.toBeUndefined();

        expect(await store.get('keep')).toBe('me');
        expect(await store.keys()).toEqual(['keep']);
    });

    it('keys lists every set key in ascending order, and nothing before the first set', async () => {
        const store = await openTracked(newFactory());
        expect(await store.keys()).toEqual([]);

        await store.set('gamma', 'c');
        await store.set('alpha', 'a');
        await store.set('beta', new Uint8Array([2]));

        expect(await store.keys()).toEqual(['alpha', 'beta', 'gamma']);

        await store.delete('beta');
        expect(await store.keys()).toEqual(['alpha', 'gamma']);
    });

    it('clear empties the store', async () => {
        const store = await openTracked(newFactory());
        await store.set('a', 'one');
        await store.set('b', new Uint8Array([2]));
        expect(await store.keys()).toHaveLength(2);

        await store.clear();

        expect(await store.keys()).toEqual([]);
        expect(await store.get('a')).toBeUndefined();
        expect(await store.get('b')).toBeUndefined();
    });

    it('clear is scoped to its own object store and leaves a sibling store untouched', async () => {
        const factory = newFactory();
        // Creating the second store in the same database is a version change, which closes the
        // first store's connection - so the first is reopened after. Two stores in one database
        // name is supported; it just costs a reopen.
        const firstSecrets = await openTracked(factory, 'shared-db', 'secrets');
        const mls = await openTracked(factory, 'shared-db', 'mls');
        expect(firstSecrets.storeName).toBe('secrets');
        const secrets = await openTracked(factory, 'shared-db', 'secrets');

        await secrets.set('master-key', new Uint8Array([1, 2, 3]));
        await mls.set('state', new Uint8Array([4, 5, 6]));

        await mls.clear();

        expect(await mls.keys()).toEqual([]);
        expect(bytes(await secrets.get('master-key'))).toEqual([1, 2, 3]);
    });

    it('values survive closing and reopening the store - the point of using IndexedDB at all', async () => {
        const factory = newFactory();
        const first = await openTracked(factory);
        await first.set('master-key', new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
        first.close();

        const second = await openTracked(factory);
        expect(bytes(await second.get('master-key'))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    });
});

describe('openStore - IndexedDB unavailable', () => {
    it('jsdom really has no indexedDB, which is what the next tests rely on', () => {
        expect((globalThis as {indexedDB?: unknown}).indexedDB).toBeUndefined();
    });

    it('rejects with IdbUnavailableError instead of resolving a store or returning undefined', async () => {
        const result = openStore('secure', 'kv');

        await expect(result).rejects.toBeInstanceOf(IdbUnavailableError);
        await expect(result).rejects.toMatchObject({kind: 'unavailable'});
        // Explicitly not a resolved-but-useless store, and explicitly not undefined.
        await expect(result).rejects.toThrow(/no IndexedDB/);
    });

    it('says in the error that there is deliberately no localStorage fallback', async () => {
        await expect(openStore('secure', 'kv')).rejects.toThrow(/localStorage fallback/);
    });

    it('reports unavailable for an object that is not an IDBFactory', async () => {
        const notAFactory = {} as unknown as IDBFactory;

        await expect(openStore('secure', 'kv', {factory: notAFactory})).rejects.toBeInstanceOf(
            IdbUnavailableError,
        );
    });

    it('reports unavailable when open() throws synchronously, as some private-browsing modes do', async () => {
        const hostile = {
            open: () => {
                throw new DOMException('The user denied permission to access the database.', 'SecurityError');
            },
        } as unknown as IDBFactory;

        const result = openStore('secure', 'kv', {factory: hostile});
        await expect(result).rejects.toBeInstanceOf(IdbUnavailableError);
        await expect(result).rejects.toMatchObject({kind: 'unavailable'});
    });

    it('isIndexedDbAvailable reflects the same judgement', () => {
        expect(isIndexedDbAvailable()).toBe(false);
        expect(isIndexedDbAvailable({} as unknown as IDBFactory)).toBe(false);
        expect(isIndexedDbAvailable(newFactory())).toBe(true);
    });
});

describe('openStore - version and blocked upgrades', () => {
    it('rejects with IdbVersionError when the stored database is newer than the version asked for', async () => {
        const factory = newFactory();
        const newer = await openTracked(factory, 'versioned', 'kv', {version: 4});
        await newer.set('k', 'v');
        newer.close();

        const result = openStore('versioned', 'kv', {factory, version: 2});
        await expect(result).rejects.toBeInstanceOf(IdbVersionError);
        await expect(result).rejects.toMatchObject({kind: 'version'});
    });

    it('opens the existing version happily when no version is pinned', async () => {
        const factory = newFactory();
        const created = await openTracked(factory, 'versioned', 'kv', {version: 4});
        await created.set('k', new Uint8Array([7]));
        created.close();

        const reopened = await openTracked(factory, 'versioned', 'kv');
        expect(bytes(await reopened.get('k'))).toEqual([7]);
    });

    it('rejects with IdbBlockedError, promptly, when another connection holds an older version open', async () => {
        const factory = newFactory();
        // A connection that ignores versionchange - i.e. another tab running older code.
        await rawOpen(factory, 'contended', 1, 'kv');

        const started = Date.now();
        // Wrapped so that "waited forever" reports as a hang rather than as a suite timeout: the
        // whole point of the blocked timeout is that boot cannot stall here.
        const result = withTimeout(
            openStore('contended', 'kv', {factory, version: 2, blockedTimeoutMs: 40}),
            2_000,
            'blocked open',
        );

        await expect(result).rejects.toBeInstanceOf(IdbBlockedError);
        await expect(result).rejects.toMatchObject({kind: 'blocked'});
        // The real requirement is that it settles at all: an unbounded wait here is a blank screen
        // on boot. 2s is generous slack over the 40ms timeout, not a performance assertion.
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("yields its own connection on versionchange so another tab's upgrade is not blocked", async () => {
        const factory = newFactory();
        const store = await openTracked(factory);
        await store.set('k', 'v');

        // Without the onversionchange -> close() handler this open would fire `blocked` and rawOpen
        // would reject; that is the mutation this test guards.
        const upgraded = await withTimeout(
            rawOpen(factory, 'test-db', 99, 'kv'),
            2_000,
            "another tab's upgrade",
        );
        expect(upgraded.version).toBe(99);

        // And the yielded store now says so, rather than failing with a raw DOMException.
        const afterClose = store.get('k');
        await expect(afterClose).rejects.toBeInstanceOf(IdbStoreClosedError);
        await expect(afterClose).rejects.toMatchObject({kind: 'closed'});
        await expect(afterClose).rejects.toThrow(/another tab upgraded/);
    });

    it('rejects every operation after close() rather than hanging or resolving undefined', async () => {
        const store = await openTracked(newFactory());
        await store.set('k', 'v');
        store.close();

        await expect(store.get('k')).rejects.toBeInstanceOf(IdbStoreClosedError);
        await expect(store.set('k', 'v2')).rejects.toBeInstanceOf(IdbStoreClosedError);
        await expect(store.delete('k')).rejects.toBeInstanceOf(IdbStoreClosedError);
        await expect(store.keys()).rejects.toBeInstanceOf(IdbStoreClosedError);
        await expect(store.clear()).rejects.toBeInstanceOf(IdbStoreClosedError);
    });

    it('adds a missing object store to an existing database with a one-step upgrade', async () => {
        const factory = newFactory();
        // Database exists at version 1 with only "other" in it.
        const other = await rawOpen(factory, 'shared-db', 1, 'other');
        expect(other.objectStoreNames.contains('kv')).toBe(false);
        other.close();

        const store = await openTracked(factory, 'shared-db', 'kv');
        await store.set('k', new Uint8Array([1]));

        expect(bytes(await store.get('k'))).toEqual([1]);
        expect(await store.keys()).toEqual(['k']);
    });

    it('refuses to invent an object store when a version is pinned', async () => {
        const factory = newFactory();
        const existing = await rawOpen(factory, 'pinned-db', 3, 'other');
        existing.close();

        await expect(openStore('pinned-db', 'kv', {factory, version: 3})).rejects.toBeInstanceOf(
            IdbVersionError,
        );
    });
});

describe('runRequest - transactions that abort rather than error', () => {
    it('rejects when a transaction aborts with no failing request - the abort-only path', async () => {
        const factory = newFactory();
        const db = await rawOpen(factory, 'abort-db', 1, 'kv');

        /*
         * This is the case the `abort` handler exists for, and it is easy to write a test that
         * misses it. Aborting while the request is still pending makes that request fire a
         * bubbling `error` event, which the transaction's `error` handler catches - so such a test
         * passes with the `abort` handler deleted, proving nothing.
         *
         * Aborting *after* the request has completed produces no error event anywhere and leaves
         * `transaction.error` null. Only the `abort` handler can settle the promise; without it,
         * this hangs. That is the real shape of a commit-time failure or a database force-closed
         * under a write.
         *
         * The abort is driven through the internal runner because no public method can abort its
         * own transaction - but the transaction, the abort and the rollback are all real.
         */
        const aborted = withTimeout(
            runRequest<unknown>(db, 'kv', 'readwrite', store => {
                const request = store.put('written', 'k');
                // addEventListener, not onsuccess, so it coexists with the runner's own handler.
                request.addEventListener('success', () => store.transaction.abort());
                return request;
            }),
            2_000,
            'abort after a completed request',
        );

        await expect(aborted).rejects.toBeInstanceOf(IdbTransactionAbortedError);
        await expect(aborted).rejects.toMatchObject({kind: 'aborted'});

        // Proof the abort was genuine and not merely an event we reported on: the write that had
        // already succeeded was rolled back.
        const after = await runRequest<unknown>(db, 'kv', 'readonly', store => store.get('k'));
        expect(after).toBeUndefined();
    });

    it('rejects when a transaction aborts while a request is still pending - the error path', async () => {
        const factory = newFactory();
        const db = await rawOpen(factory, 'abort-db', 1, 'kv');

        // The other arrival order: the pending request fires `error` (AbortError) and it bubbles.
        // Both orders must reject, and both must roll back.
        const aborted = withTimeout(
            runRequest<unknown>(db, 'kv', 'readwrite', store => {
                const request = store.put('written', 'k');
                store.transaction.abort();
                return request;
            }),
            2_000,
            'abort during a pending request',
        );

        await expect(aborted).rejects.toBeInstanceOf(IdbTransactionAbortedError);

        const after = await runRequest<unknown>(db, 'kv', 'readonly', store => store.get('k'));
        expect(after).toBeUndefined();
    });

    it('rejects rather than resolving when the request itself fails', async () => {
        const factory = newFactory();
        const db = await rawOpen(factory, 'abort-db', 1, 'kv');

        // A write against a readonly transaction: the request throws synchronously, and the
        // transaction must not be left open.
        const failed = withTimeout(
            runRequest<unknown>(db, 'kv', 'readonly', store => store.put('nope', 'k')),
            2_000,
            'readonly write',
        );

        await expect(failed).rejects.toThrow();
        const after = await runRequest<unknown>(db, 'kv', 'readonly', store => store.get('k'));
        expect(after).toBeUndefined();
    });

    it('rejects when the object store does not exist, instead of hanging', async () => {
        const factory = newFactory();
        const db = await rawOpen(factory, 'abort-db', 1, 'kv');

        await expect(
            withTimeout(
                runRequest<unknown>(db, 'missing-store', 'readonly', store => store.get('k')),
                2_000,
                'missing store',
            ),
        ).rejects.toThrow();
    });
});

describe('openStore - concurrency', () => {
    it('resolves concurrent set()s to the same key in call order, last write winning', async () => {
        const store = await openTracked(newFactory());

        await Promise.all([store.set('k', 'first'), store.set('k', 'second'), store.set('k', 'third')]);

        expect(await store.get('k')).toBe('third');
        expect(await store.keys()).toEqual(['k']);
    });

    it('is deterministic across repeated races, not just lucky once', async () => {
        const store = await openTracked(newFactory());

        for (let round = 0; round < 10; round++) {
            const writes = Array.from({length: 6}, (_, i) => store.set('k', `round${round}-write${i}`));
            await Promise.all(writes);
            expect(await store.get('k')).toBe(`round${round}-write5`);
        }
    });

    it('never leaves a torn binary value when concurrent writes differ in length', async () => {
        const store = await openTracked(newFactory());
        const short = new Uint8Array([1, 2]);
        const long = new Uint8Array(1024).fill(0xab);

        await Promise.all([store.set('blob', short), store.set('blob', long), store.set('blob', short)]);

        // The last write wins whole; a partially applied write would show up as some other length.
        expect(bytes(await store.get('blob'))).toEqual([1, 2]);
    });

    it('a read issued after a write sees that write, not the previous value', async () => {
        const store = await openTracked(newFactory());
        await store.set('k', 'old');

        // IndexedDB serialises overlapping-scope transactions in creation order, so the readonly
        // transaction created second must observe the committed write.
        const [, read] = await Promise.all([store.set('k', 'new'), store.get('k')]);

        expect(read).toBe('new');
    });

    it('interleaved writes to different keys all land', async () => {
        const store = await openTracked(newFactory());

        await Promise.all(
            Array.from({length: 25}, (_, i) =>
                store.set(`key-${String(i).padStart(2, '0')}`, new Uint8Array([i])),
            ),
        );

        const keys = await store.keys();
        expect(keys).toHaveLength(25);
        expect(bytes(await store.get('key-00'))).toEqual([0]);
        expect(bytes(await store.get('key-24'))).toEqual([24]);
    });
});

describe('openStore - value typing', () => {
    it('rejects a value it cannot round-trip, and writes nothing', async () => {
        const store = await openTracked(newFactory());

        await expect(store.set('k', 42 as unknown as string)).rejects.toBeInstanceOf(TypeError);
        await expect(store.set('k2', {a: 1} as unknown as string)).rejects.toBeInstanceOf(TypeError);
        await expect(store.set('k3', null as unknown as string)).rejects.toBeInstanceOf(TypeError);

        expect(await store.keys()).toEqual([]);
    });

    it('rejects with IdbCorruptValueError when something else wrote a foreign value', async () => {
        const factory = newFactory();
        const db = await rawOpen(factory, 'foreign-db', 1, 'kv');
        // Bypass the store to plant a value of a type it never writes, as a schema change or a
        // different writer would.
        await runRequest<unknown>(db, 'kv', 'readwrite', store => store.put({not: 'ours'}, 'planted'));
        db.close();

        const store = await openTracked(factory, 'foreign-db', 'kv');
        const result = store.get('planted');

        await expect(result).rejects.toBeInstanceOf(IdbCorruptValueError);
        await expect(result).rejects.toMatchObject({kind: 'corrupt'});
    });
});

describe('classifyIdbError', () => {
    /*
     * Direct unit tests of the mapping, for the failures that cannot be provoked in-process.
     * fake-indexeddb enforces no quota, so this is the only coverage the quota path has - the
     * classification is verified here, real storage pressure is not verified anywhere.
     */
    it('maps QuotaExceededError to IdbQuotaExceededError', () => {
        const error = classifyIdbError(
            new DOMException('The quota has been exceeded.', 'QuotaExceededError'),
            'readwrite transaction on "kv"',
        );

        expect(error.kind).toBe('quota');
        expect(error.name).toBe('IdbQuotaExceededError');
        expect(error.message).toMatch(/quota/i);
        expect(error.cause).toBeInstanceOf(DOMException);
    });

    it('maps VersionError, AbortError and InvalidStateError to their own kinds', () => {
        expect(classifyIdbError(new DOMException('v', 'VersionError'), 'x').kind).toBe('version');
        expect(classifyIdbError(new DOMException('a', 'AbortError'), 'x').kind).toBe('aborted');
        expect(classifyIdbError(new DOMException('s', 'InvalidStateError'), 'x').kind).toBe('closed');
    });

    it('still produces a rejectable error for an unrecognised failure', () => {
        const error = classifyIdbError(new DOMException('weird', 'UnknownError'), 'context');

        expect(error.kind).toBe('unknown');
        expect(error.message).toContain('context');
        expect(error.message).toContain('UnknownError');
    });

    it('treats a null transaction error on abort as an abort, not as unknown', () => {
        // tx.error is null for an explicit abort(), which must not degrade to a vague error.
        expect(classifyIdbError(null, 'context', 'aborted').kind).toBe('aborted');
    });

    it('passes an already-classified error through unchanged', () => {
        const original = new IdbUnavailableError('no indexeddb');
        expect(classifyIdbError(original, 'context')).toBe(original);
    });
});
