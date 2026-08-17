import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {SecureStore} from '../../platform/ports/secure-store.port';
import {DeviceIdentityService} from '../device-identity.service';
import {CacheSealService} from './cache-seal.service';

/** A 32-byte key, base64, the shape `localStateKey` stores. */
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

class FakeSecureStore extends SecureStore {
    readonly hardwareBacked = false;
    getItemCalls = 0;
    updateCalls = 0;
    /** Every name read, so a spec can prove the key was looked up under the right device id. */
    readonly names: string[] = [];
    constructor(public value: string | null) { super(); }
    async getItem(name: string): Promise<string | null> {
        this.getItemCalls++;
        this.names.push(name);
        return this.value;
    }
    async setItem(): Promise<void> { /* unused */ }
    async removeItem(): Promise<void> { /* unused */ }
    override async update(): Promise<string | null> { this.updateCalls++; return this.value; }
}

/** The device id the fake identity service answers with. Mutable, to model a sign-out. */
let deviceId = 'device-a';

function configure(store: SecureStore): CacheSealService {
    deviceId = 'device-a';
    TestBed.configureTestingModule({
        providers: [
            {provide: SecureStore, useValue: store},
            {provide: DeviceIdentityService, useValue: {deviceId: async () => deviceId}},
        ],
    });
    return TestBed.inject(CacheSealService);
}

describe('CacheSealService', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('round-trips a value through the stored key', async () => {
        const seal = configure(new FakeSecureStore(KEY));
        const sealed = await seal.seal({userName: 'ada'});
        expect(sealed).not.toBeNull();
        expect(sealed).not.toContain('ada');
        expect(await seal.unseal<{userName: string}>(sealed!)).toEqual({userName: 'ada'});
    });

    it('reports unavailable and never mints when the key is absent', async () => {
        // SecureStore collapses a locked read to null, so minting here would orphan every entry the
        // cache has written, and every MLS group key sealed under the real one.
        const store = new FakeSecureStore(null);
        const seal = configure(store);

        expect(await seal.available()).toBe(false);
        expect(await seal.seal({userName: 'ada'})).toBeNull();
        expect(store.updateCalls).toBe(0);
    });

    it('returns null rather than throwing when the ciphertext will not open', async () => {
        const seal = configure(new FakeSecureStore(KEY));
        expect(await seal.unseal('bm90LWl2.bm90LWNpcGhlcnRleHQ=')).toBeNull();
    });

    it('returns null for a malformed entry with no separator', async () => {
        const seal = configure(new FakeSecureStore(KEY));
        expect(await seal.unseal('no-separator-here')).toBeNull();
    });

    /**
     * The launch-order bug: hydration runs before `MlsService.initStorage` mints the state key, so
     * a first-ever launch legitimately reads absent. That `null` must never be memoised.
     */
    it('re-reads a key that was absent the first time, rather than memoising the null', async () => {
        const store = new FakeSecureStore(null);
        const seal = configure(store);

        expect(await seal.available()).toBe(false);

        store.value = KEY;

        expect(await seal.available()).toBe(true);
        expect(await seal.seal({userName: 'ada'})).not.toBeNull();
    });

    /**
     * A sign-out is an in-document navigate, so this service outlives the account whose key it
     * first read. One memoised key would seal account B's cache entries under account A's.
     */
    it('reads the key of the account signed in now, not the one it started with', async () => {
        const store = new FakeSecureStore(KEY);
        const seal = configure(store);
        await seal.available();
        expect(store.names).toEqual(['alpine_mls_device-a_statekey']);

        deviceId = 'device-b';
        await seal.available();

        expect(store.names).toEqual([
            'alpine_mls_device-a_statekey', 'alpine_mls_device-b_statekey',
        ]);
    });

    it('returns null for a value sealed under a different key', async () => {
        const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
        const sealed = await configure(new FakeSecureStore(KEY)).seal({userName: 'ada'});

        TestBed.resetTestingModule();
        expect(await configure(new FakeSecureStore(other)).unseal(sealed!)).toBeNull();
    });
});
