import {IDBFactory as FakeIdbFactory} from 'fake-indexeddb';
import {beforeEach, describe, expect, it} from 'vitest';

import {CacheStore, DOMAIN_RESERVES} from './cache-store';
import {FakeLockManager} from './testing/fake-lock-manager';
import {IdbStore, openStore} from './web/idb';

/** A seal that is the identity function, so these tests assert on budgeting, not on crypto. */
const PLAIN = {
    seal: async (v: unknown) => JSON.stringify(v),
    unseal: async <T>(s: string) => JSON.parse(s) as T,
    available: async () => true,
};

let factory: IDBFactory;
let store: CacheStore;

/**
 * Headroom subtracted from a tenth of the reserve when sizing a "bulk" test entry.
 *
 * <p>What is actually budgeted is `sealed.length + scoped.length` - the JSON-stringified value plus
 * its `device::domain::key` prefix - not the raw bulk string. That envelope costs roughly
 * `{"bulk":"` + `"}` (11 bytes) plus the scoped key (about 21-22 bytes here), so a bulk string sized
 * at exactly a tenth of the reserve leaves the ten setup entries in these tests a few hundred bytes
 * *over* budget - eviction fires mid-setup and the LRU protection the test means to exercise never
 * gets a chance to run. This headroom is generous on purpose, so the fixture is not this fragile
 * again if the key or wrapper format changes.
 */
const BULK_HEADROOM_BYTES = 1000;

function makeStore(): CacheStore {
    return new CacheStore(
        'device-a', PLAIN as never,
        () => openStore('alpine-cache-test', 'entries', {factory}));
}

/**
 * One store that records every write of the index row.
 *
 * <p>Delegated explicitly rather than spread, for the reason `mls-local-store.web.spec.ts` gives:
 * `openStore` returns a class instance and `{...store}` copies none of its prototype methods.</p>
 */
async function countingStore(indexWrites: string[]): Promise<IdbStore> {
    const real = await openStore('alpine-cache-test', 'entries', {factory});
    return {
        dbName: real.dbName,
        storeName: real.storeName,
        get: key => real.get(key),
        set: (key, value) => {
            if (key.startsWith('__index')) indexWrites.push(key);
            return real.set(key, value);
        },
        delete: key => real.delete(key),
        keys: () => real.keys(),
        clear: () => real.clear(),
        close: () => real.close(),
    };
}

describe('CacheStore', () => {
    beforeEach(() => {
        factory = new FakeIdbFactory();
        store = makeStore();
    });

    it('round-trips a value', async () => {
        await store.set('profile', 'u1', {userName: 'ada'});
        expect(await store.get('profile', 'u1')).toEqual({userName: 'ada'});
    });

    it('returns undefined for a key it does not hold', async () => {
        expect(await store.get('profile', 'nobody')).toBeUndefined();
    });

    it('lists a whole domain without listing the other', async () => {
        await store.set('profile', 'u1', {userName: 'ada'});
        await store.set('message', 'c1', [{id: 'm1'}]);

        expect((await store.all('profile')).map(([k]) => k)).toEqual(['u1']);
        expect((await store.all('message')).map(([k]) => k)).toEqual(['c1']);
    });

    it('survives a reopen, which is the entire point', async () => {
        await store.set('profile', 'u1', {userName: 'ada'});
        expect(await makeStore().get('profile', 'u1')).toEqual({userName: 'ada'});
    });

    it('never lets one account read another account\'s entries', async () => {
        await store.set('profile', 'u1', {userName: 'ada'});

        const other = new CacheStore(
            'device-b', PLAIN as never,
            () => openStore('alpine-cache-test', 'entries', {factory}));

        expect(await other.get('profile', 'u1')).toBeUndefined();
    });

    it('evicts the least recently used entry once its domain is over reserve', async () => {
        // One entry a little over a tenth of the reserve, so eleven do not fit.
        const bulk = 'x'.repeat(Math.floor(DOMAIN_RESERVES.profile / 10) - BULK_HEADROOM_BYTES);

        for (let i = 0; i < 11; i++) await store.set('profile', `u${i}`, {bulk});

        expect(await store.get('profile', 'u0')).toBeUndefined();
        expect(await store.get('profile', 'u10')).toEqual({bulk});
        expect(store.sizeOf('profile')).toBeLessThanOrEqual(DOMAIN_RESERVES.profile);
    });

    it('counts a rewritten key once, not twice', async () => {
        await store.set('profile', 'u1', {bulk: 'x'.repeat(1000)});
        const first = store.sizeOf('profile');
        await store.set('profile', 'u1', {bulk: 'x'.repeat(1000)});

        expect(store.sizeOf('profile')).toBe(first);
    });

    it('reading an entry protects it from the next eviction', async () => {
        const bulk = 'x'.repeat(Math.floor(DOMAIN_RESERVES.profile / 10) - BULK_HEADROOM_BYTES);
        for (let i = 0; i < 10; i++) await store.set('profile', `u${i}`, {bulk});

        await store.get('profile', 'u0');       // u0 is now the most recently used
        await store.set('profile', 'u10', {bulk});

        expect(await store.get('profile', 'u0')).toEqual({bulk});
        expect(await store.get('profile', 'u1')).toBeUndefined();
    });

    it('one domain never evicts another below its reserve', async () => {
        await store.set('message', 'c1', {keep: true});

        const bulk = 'x'.repeat(Math.floor(DOMAIN_RESERVES.profile / 10) - BULK_HEADROOM_BYTES);
        for (let i = 0; i < 12; i++) await store.set('profile', `u${i}`, {bulk});

        expect(await store.get('message', 'c1')).toEqual({keep: true});
    });

    /**
     * An index entry is around 110 bytes, so two thousand cached profiles is a ~220 KB index - and
     * `ProfileCacheService.revalidateAll` calls `set()` once per hydrated profile, on the main
     * thread, right after launch. One re-seal and one full rewrite per call is the cost the
     * separate-index design exists to avoid, and it was left on `set()` when it was taken off
     * `get()`.
     */
    it('does not rewrite the whole index once per set', async () => {
        const indexWrites: string[] = [];
        const batching = new CacheStore(
            'device-a', PLAIN as never, () => countingStore(indexWrites));

        for (let i = 0; i < 10; i++) await batching.set('profile', `u${i}`, {userName: `u${i}`});

        // One write-through for the first change, then one batch for the rest of the window.
        expect(indexWrites.length).toBeLessThan(10);
    });

    it('a single set is still durable the moment it resolves', async () => {
        // The other half of the batching rule: batching a burst must not turn one write into a
        // write that has not happened yet.
        await store.set('profile', 'u1', {userName: 'ada'});

        expect(await makeStore().get('profile', 'u1')).toEqual({userName: 'ada'});
    });

    it('clear persists the index immediately rather than joining a batch', async () => {
        const indexWrites: string[] = [];
        const batching = new CacheStore(
            'device-a', PLAIN as never, () => countingStore(indexWrites));
        for (let i = 0; i < 5; i++) await batching.set('profile', `u${i}`, {userName: `u${i}`});
        const before = indexWrites.length;

        await batching.clear();

        // A clear whose index write was still sitting in a timer would leave the signed-out
        // account's contact graph listed after the wipe that was meant to remove it.
        expect(indexWrites.length).toBe(before + 1);
        expect(await makeStore().all('profile')).toEqual([]);
    });

    it('stops charging for an entry whose payload can no longer be read', async () => {
        const raw = await openStore('alpine-cache-test', 'entries', {factory});
        await store.set('profile', 'u1', {userName: 'ada'});
        expect(store.sizeOf('profile')).toBeGreaterThan(0);

        // The payload row goes; the index entry still lists it and still charges for it.
        await raw.delete('device-a::profile::u1');

        expect(await store.get('profile', 'u1')).toBeUndefined();
        expect(store.sizeOf('profile')).toBe(0);
        expect(await store.all('profile')).toEqual([]);
    });

    it('clear empties this device and leaves another device alone', async () => {
        const other = new CacheStore(
            'device-b', PLAIN as never,
            () => openStore('alpine-cache-test', 'entries', {factory}));

        await store.set('profile', 'u1', {userName: 'ada'});
        await other.set('profile', 'u2', {userName: 'grace'});
        await store.clear();

        expect(await store.get('profile', 'u1')).toBeUndefined();
        expect(await other.get('profile', 'u2')).toEqual({userName: 'grace'});
    });
});

/**
 * The whole index is one row, so writing it is a read-modify-write on a single key - the shape
 * `mls-local-store.web.spec.ts` exists for, arrived at from a different direction.
 *
 * <p>The failure is not a lost cache entry. Tab A caches forty profiles; tab B starts up and its
 * first write serialises <i>its</i> index - which never held A's forty - over the stored one. The
 * forty payload rows are then listed by nothing: not by `sizeOf`, so they are never evicted; not by
 * `all`, so they are not serving the user; and not by `clear`, so <b>they survive a sign-out
 * wipe</b>. Cached profiles and unencrypted message bodies outliving the wipe that was supposed to
 * remove them is the reason this is a security test and not a correctness one.</p>
 *
 * <p>So every test here runs two or three stores over <b>one {@link FakeLockManager} and one
 * IndexedDB</b> - the shared manager and the shared database are the browser profile. Giving each
 * "tab" its own would make all of it pass vacuously.</p>
 */
describe('CacheStore across two tabs of one account', () => {
    let profile: FakeLockManager;

    /** One tab of this profile: the profile's database and lock manager, its own memory. */
    function openTab(windowMs = 0): CacheStore {
        return new CacheStore(
            'device-a', PLAIN as never,
            () => openStore('alpine-cache-test', 'entries', {factory}),
            // Unbatched by default: what is under test is revalidation, not the write window.
            windowMs, profile);
    }

    beforeEach(() => {
        factory = new FakeIdbFactory();
        profile = new FakeLockManager();
    });

    it('takes one exclusive lock, named for the device', async () => {
        await openTab().set('profile', 'u1', {userName: 'ada'});

        expect(profile.requested).toContain('venta:cache-store::device-a');
    });

    it('a tab that has already read the index cannot erase another tab\'s entries', async () => {
        const tabA = openTab();
        const tabB = openTab();
        // B looks at the cache before A writes, so the copy it holds is the empty one. A tab that
        // opened afterwards would load A's entries by accident and prove nothing.
        expect(await tabB.get('profile', 'nobody')).toBeUndefined();

        for (const id of ['u1', 'u2', 'u3']) await tabA.set('profile', id, {userName: id});
        await tabB.set('profile', 'u4', {userName: 'u4'});

        // Read by a third tab, so neither writer's own in-memory index can be answering.
        const listed = (await openTab().all('profile')).map(([key]) => key).sort();
        expect(listed).toEqual(['u1', 'u2', 'u3', 'u4']);
    });

    it('a wipe leaves no payload row behind, including the other tab\'s', async () => {
        const tabA = openTab();
        await tabA.set('profile', 'u1', {userName: 'ada'});

        const tabB = openTab();
        await tabB.set('profile', 'u2', {userName: 'grace'});
        await tabA.clear();

        // Asserted against the object store rather than through `all()`, deliberately: a row the
        // index has lost track of is invisible to every read path and still sitting on disk, which
        // is precisely what makes it survive a sign-out.
        const raw = await openStore('alpine-cache-test', 'entries', {factory});
        expect((await raw.keys()).filter(key => key.startsWith('device-a::'))).toEqual([]);
    });

    /**
     * Batching and revalidation are in direct conflict unless the unflushed changes are re-applied
     * over the reloaded copy: another tab's write landing mid-window would otherwise drop them
     * from the index while their payload rows stayed on disk - the same orphaning, from inside.
     */
    it('does not lose a batched entry to another tab writing mid-window', async () => {
        const tabA = openTab(10_000);
        await tabA.set('profile', 'u1', {userName: 'ada'});      // written through
        await tabA.set('profile', 'u2', {userName: 'grace'});    // batched, only in memory

        const tabB = openTab();
        await tabB.set('profile', 'u3', {userName: 'hopper'});   // publishes an index without u2

        // delete() is never batched, so this forces tab A to revalidate and publish.
        await tabA.delete('profile', 'u1');

        const listed = (await openTab().all('profile')).map(([key]) => key).sort();
        expect(listed).toEqual(['u2', 'u3']);
    });
});
