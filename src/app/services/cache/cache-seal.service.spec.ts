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
    constructor(private value: string | null) { super(); }
    async getItem(): Promise<string | null> { this.getItemCalls++; return this.value; }
    async setItem(): Promise<void> { /* unused */ }
    async removeItem(): Promise<void> { /* unused */ }
    override async update(): Promise<string | null> { this.updateCalls++; return this.value; }
}

function configure(store: SecureStore): CacheSealService {
    TestBed.configureTestingModule({
        providers: [
            {provide: SecureStore, useValue: store},
            {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device-a'}},
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
        // The whole point. SecureStore collapses a locked read to null, so minting here would
        // orphan every entry the cache has ever written - and, if it landed on the same name,
        // every MLS group key sealed under the real one.
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

    it('returns null for a value sealed under a different key', async () => {
        const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
        const sealed = await configure(new FakeSecureStore(KEY)).seal({userName: 'ada'});

        TestBed.resetTestingModule();
        expect(await configure(new FakeSecureStore(other)).unseal(sealed!)).toBeNull();
    });
});
