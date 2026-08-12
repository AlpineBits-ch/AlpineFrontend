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
 * The key the MLS engine state is sealed under, and the one way a second tab could destroy it.
 *
 * <p><b>What it is.</b> `MlsService.localStateKey` reads `alpine_mls_{deviceId}_statekey` and mints a
 * fresh 32-byte key when there is none. Everything the engine persists - on web, the whole exported
 * blob in IndexedDB - is sealed under it, so the key and the blob are one artefact: replace the key and
 * the blob is gone, on a machine that still physically holds it.</p>
 *
 * <p><b>Why that is a cross-tab problem.</b> Read-then-mint-then-write is a read-modify-write, and in a
 * browser there is one store per tab. Two tabs of one account booting together both read absence, both
 * mint a <i>different</i> key, and the loser's blob can never be opened again. It does not surface as a
 * storage bug; it surfaces a launch later as `MlsStateUnreadableError`, which the boot path answers by
 * wiping the device's group state. So the read and the mint have to be one operation against storage -
 * {@link SecureStore.update} - and this file proves it with a store whose plain `getItem` is behind,
 * which is what any cached or racing reader looks like from here.</p>
 */

const DEVICE_ID = 'device-a';
const STATE_KEY_ENTRY = `alpine_mls_${DEVICE_ID}_statekey`;
const REAL_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/**
 * A key store whose `getItem` can be made to answer something other than what is stored.
 *
 * <p>`update` reads {@link stored} directly, which is the port's contract: the read that decides
 * happens inside the critical section, against storage, not against whatever the caller last saw.</p>
 */
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

        // Minting here replaces the key the engine blob is sealed under, and no later launch can open
        // it - which is answered by wiping this device's group state.
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
