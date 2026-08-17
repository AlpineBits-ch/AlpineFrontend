import {TestBed} from '@angular/core/testing';
import {firstValueFrom} from 'rxjs';
import {beforeEach, describe, expect, it} from 'vitest';

import {MlsEngine} from '../platform/ports/mls-engine.port';
import {MlsLocalStoreFactory} from '../platform/ports/mls-local-store.port';
import {SecureStore} from '../platform/ports/secure-store.port';
import {FakeMlsEngine} from '../platform/testing/fake-mls-engine';
import {FakeMlsLocalStoreFactory} from '../platform/testing/fake-mls-local-store';
import {DeviceIdentityService} from './device-identity.service';
import {MlsService} from './mls.service';

/**
 * The engine state key is per device (`alpine_mls_{deviceId}_statekey`) and the persisted blob is
 * sealed under it, so replacing the key destroys the state on a machine that still holds it.
 *
 * Read and mint must therefore be one operation against storage ({@link SecureStore.update}): two
 * tabs that both read absence would mint different keys and the loser's blob never opens again.
 */

const DEVICE_ID = 'device-a';
const STATE_KEY_ENTRY = `alpine_mls_${DEVICE_ID}_statekey`;
const REAL_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** A key store whose `getItem` can answer something other than what is stored; `update` reads {@link stored} directly, per the port's contract. */
class StaleReadSecureStore extends SecureStore {
    readonly hardwareBacked = false;

    /** What is really there. What another tab would find. */
    readonly stored = new Map<string, string>();

    /** What this tab's reader answers instead, per key. `null` stands for "reads as absent". */
    readonly stale = new Map<string, string | null>();

    async getItem(key: string): Promise<string | null> {
        if (this.stale.has(key)) return this.stale.get(key) ?? null;
        return this.stored.get(key) ?? null;
    }

    async setItem(key: string, value: string): Promise<void> {
        this.stored.set(key, value);
        this.stale.delete(key);
    }

    async removeItem(key: string): Promise<void> {
        this.stored.delete(key);
        this.stale.delete(key);
    }

    override async update(
        key: string,
        next: (current: string | null) => string | null,
    ): Promise<string | null> {
        const current = this.stored.get(key) ?? null;
        const value = next(current);
        if (value === current) return current;
        this.stale.delete(key);
        if (value === null) this.stored.delete(key);
        else this.stored.set(key, value);
        return value;
    }
}

describe('MlsService and the engine state key', () => {
    let service: MlsService;
    let keys: StaleReadSecureStore;
    let engine: FakeMlsEngine;

    beforeEach(() => {
        keys = new StaleReadSecureStore();
        engine = new FakeMlsEngine();
        engine.result = false;
        TestBed.configureTestingModule({
            providers: [
                MlsService,
                {provide: MlsEngine, useValue: engine},
                {provide: SecureStore, useValue: keys},
                {provide: MlsLocalStoreFactory, useValue: new FakeMlsLocalStoreFactory()},
                {
                    provide: DeviceIdentityService,
                    useValue: {deviceId: async () => DEVICE_ID, ownsLegacyState: async () => false},
                },
            ],
        });
        service = TestBed.inject(MlsService);
    });

    /** What the engine was handed to seal and unseal its state with. */
    const suppliedKey = () => engine.lastCall('mls_init_storage')?.args?.['stateKeyB64'];

    it('mints a key on a device that has none, and keeps it', async () => {
        await firstValueFrom(service.initStorage());
        const minted = keys.stored.get(STATE_KEY_ENTRY);
        expect(minted).toBeTypeOf('string');

        await firstValueFrom(service.initStorage());

        expect(keys.stored.get(STATE_KEY_ENTRY)).toBe(minted);
        expect(suppliedKey()).toBe(minted);
    });

    it('does not mint over a key this tab happens not to see', async () => {
        // The shape of the race: another tab minted a moment ago, and this tab's read is behind.
        keys.stored.set(STATE_KEY_ENTRY, REAL_KEY);
        keys.stale.set(STATE_KEY_ENTRY, null);

        await firstValueFrom(service.initStorage());

        // Minting here would replace the key the blob is sealed under, and no later launch could
        // open it.
        expect(keys.stored.get(STATE_KEY_ENTRY)).toBe(REAL_KEY);
        expect(suppliedKey()).toBe(REAL_KEY);
    });

    it('mints over an empty string, which cannot be a key under any encoding', async () => {
        keys.stored.set(STATE_KEY_ENTRY, '');

        await firstValueFrom(service.initStorage());

        const minted = keys.stored.get(STATE_KEY_ENTRY);
        expect(minted).toBeTypeOf('string');
        expect(minted).not.toBe('');
        expect(suppliedKey()).toBe(minted);
    });

    it('refuses rather than minting when the read faulted half-way', async () => {
        // `undefined` is off the port's contract, so it is a store that could not read rather than a
        // device with no entry. Minting over it is what turns a recoverable fault into permanent loss.
        keys.stored.set(STATE_KEY_ENTRY, REAL_KEY);
        Object.defineProperty(keys, 'update', {
            value: (_key: string, next: (current: string | null) => string | null) =>
                Promise.resolve().then(() => next(undefined as unknown as string | null)),
        });

        await expect(firstValueFrom(service.initStorage())).rejects.toThrow(/resolved undefined/);

        expect(keys.stored.get(STATE_KEY_ENTRY)).toBe(REAL_KEY);
    });

    it('says so rather than sealing under nothing if the store answers no key at all', async () => {
        Object.defineProperty(keys, 'update', {value: () => Promise.resolve(null)});

        await expect(firstValueFrom(service.initStorage())).rejects.toThrow(/without a state key/);

        expect(engine.lastCall('mls_init_storage')).toBeUndefined();
    });
});
