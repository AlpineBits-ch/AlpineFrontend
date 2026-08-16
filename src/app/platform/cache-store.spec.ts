import {IDBFactory as FakeIdbFactory} from 'fake-indexeddb';
import {beforeEach, describe, expect, it} from 'vitest';

import {CacheStore, DOMAIN_RESERVES} from './cache-store';
import {openStore} from './web/idb';

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
