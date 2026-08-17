import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';

import {MlsEngine} from '../platform/ports/mls-engine.port';
import {MlsLocalStore, MlsLocalStoreFactory} from '../platform/ports/mls-local-store.port';
import {SecureStore} from '../platform/ports/secure-store.port';
import {FakeMlsEngine} from '../platform/testing/fake-mls-engine';
import {FakeSecureStore} from '../platform/testing/fake-secure-store';
import {DeviceIdentityService} from './device-identity.service';
import {MlsService} from './mls.service';

/**
 * The monotonic encryption floor, and the one way it could still be lowered.
 *
 * <p><b>What the floor is for.</b> Encryption state arrives from the server, and a server that answers
 * `{encrypted: false}` for a context this device has been encrypting gets `clearActiveGeneration`
 * called - after which the next composed message goes out in <i>plaintext</i>, into a conversation
 * whose whole point was that it could not. `ctx#floor` is the local record that refuses that: the
 * highest generation this device has ever held a group for, raised and never lowered, consulted before
 * anything is composed in the clear (§L.6, §L.9).</p>
 *
 * <p><b>What this file pins.</b> "Raised and never lowered" was implemented as a read, a comparison and
 * a write, and that is only monotonic if nothing writes in between. In a browser something does: the
 * local stores run one per tab, so a second tab's raise lands between this one's read and its write and
 * the <i>lower</i> generation is written last. So the comparison has to happen inside the store, against
 * what is stored, and this file proves it by handing `MlsService` a store whose plain `get` is
 * deliberately behind - which is exactly the shape of the web adapter's in-memory mirror after another
 * tab has written.</p>
 */

const DEVICE_ID = 'device-a';
const CONTEXT = 'ctx-1';
const FLOOR = `${CONTEXT}#floor`;

/**
 * A store whose `get` answers from a stale snapshot and whose `update` answers from storage.
 *
 * <p>Not a contrivance: it is the contract `MlsLocalStore.update` states and the behaviour
 * `IdbMlsLocalStore` has, because its mirror is built once per revision and another tab's write is only
 * seen by the read `update` performs inside its critical section. A service that reaches for `get`
 * before deciding is reading the mirror, and this makes that visible instead of timing-dependent.</p>
 */
class StaleReadStore implements MlsLocalStore {
    /** What is really stored. What another tab would see. */
    readonly stored = new Map<string, unknown>();

    /** What this tab's cache still believes. Consulted by `get` and by `entries` only. */
    readonly stale = new Map<string, unknown>();

    async get<T>(key: string): Promise<T | undefined> {
        return (this.stale.has(key) ? this.stale.get(key) : this.stored.get(key)) as T | undefined;
    }

    async set(key: string, value: unknown): Promise<void> {
        this.stored.set(key, value);
        this.stale.delete(key);
    }

    async delete(key: string): Promise<boolean> {
        this.stale.delete(key);
        return this.stored.delete(key);
    }

    async update<T>(key: string, next: (current: T | undefined) => T | undefined): Promise<T | undefined> {
        const current = this.stored.get(key) as T | undefined;
        const value = next(current);
        if (value === current) return current;
        this.stale.delete(key);
        if (value === undefined) this.stored.delete(key);
        else this.stored.set(key, value);
        return value;
    }

    async entries<T>(): Promise<[string, T][]> {
        const merged = new Map(this.stored);
        for (const [key, value] of this.stale) merged.set(key, value);
        return [...merged.entries()] as [string, T][];
    }

    async clear(): Promise<void> {
        this.stored.clear();
        this.stale.clear();
    }

    async save(): Promise<void> {
        // Nothing is buffered.
    }
}

class StaleReadStoreFactory extends MlsLocalStoreFactory {
    readonly files = new Map<string, StaleReadStore>();

    open(file: string): MlsLocalStore {
        let store = this.files.get(file);
        if (!store) {
            store = new StaleReadStore();
            this.files.set(file, store);
        }
        return store;
    }

    /** The group registry for the pinned device id, which is the only file this spec writes. */
    get registry(): StaleReadStore {
        return this.open(`mls-group-registry-${DEVICE_ID}.json`) as StaleReadStore;
    }
}

describe('MlsService and the monotonic encryption floor', () => {
    let service: MlsService;
    let stores: StaleReadStoreFactory;

    beforeEach(() => {
        stores = new StaleReadStoreFactory();
        TestBed.configureTestingModule({
            providers: [
                MlsService,
                {provide: MlsEngine, useValue: new FakeMlsEngine()},
                {provide: SecureStore, useValue: new FakeSecureStore()},
                {provide: MlsLocalStoreFactory, useValue: stores},
                {provide: DeviceIdentityService, useValue: {deviceId: async () => DEVICE_ID}},
            ],
        });
        service = TestBed.inject(MlsService);
    });

    it('records the floor the first time a group is registered', async () => {
        await service.registerGroup(CONTEXT, 2, 'Z3JvdXA=');

        expect(stores.registry.stored.get(FLOOR)).toBe(2);
        await expect(service.getEncryptionFloor(CONTEXT)).resolves.toBe(2);
    });

    it('raises the floor for a later generation', async () => {
        await service.registerGroup(CONTEXT, 2, 'Z3JvdXAx');

        await service.registerGroup(CONTEXT, 5, 'Z3JvdXAy');

        expect(stores.registry.stored.get(FLOOR)).toBe(5);
    });

    it('does not lower the floor for an earlier generation', async () => {
        await service.registerGroup(CONTEXT, 5, 'Z3JvdXAy');

        await service.registerGroup(CONTEXT, 2, 'Z3JvdXAx');

        expect(stores.registry.stored.get(FLOOR)).toBe(5);
    });

    it('does not lower a floor another tab raised while this one was not looking', async () => {
        // What the browser adapter's mirror looks like after the other tab has worked: this tab still
        // believes the floor is 2, and storage says 9.
        stores.registry.stored.set(FLOOR, 9);
        stores.registry.stale.set(FLOOR, 2);

        await service.registerGroup(CONTEXT, 3, 'Z3JvdXAz');

        // Deciding from the cached 2 would write 3 here, and every generation from 4 to 9 would then be
        // composable in the clear in a conversation this account has encrypted.
        expect(stores.registry.stored.get(FLOOR)).toBe(9);
    });

    it('still raises the floor when the cached value is the stale one that is too high', async () => {
        // The mirror image, and the reason a naive "trust the higher of the two" is not the fix: a
        // cache ahead of storage would suppress a raise that has to happen.
        stores.registry.stored.set(FLOOR, 1);
        stores.registry.stale.set(FLOOR, 8);

        await service.registerGroup(CONTEXT, 4, 'Z3JvdXA0');

        expect(stores.registry.stored.get(FLOOR)).toBe(4);
    });

    it('keeps the floor when the active generation is cleared, which is the whole point of it', async () => {
        await service.registerGroup(CONTEXT, 3, 'Z3JvdXAz');

        // "The server says encryption is off now" is precisely the claim the floor exists to refuse.
        await service.clearActiveGeneration(CONTEXT);

        await expect(service.getKnownGeneration(CONTEXT)).resolves.toBeNull();
        await expect(service.getEncryptionFloor(CONTEXT)).resolves.toBe(3);
    });

    it('lowers the floor only for an explicit, user-confirmed disable', async () => {
        await service.registerGroup(CONTEXT, 3, 'Z3JvdXAz');

        await service.clearEncryptionFloor(CONTEXT);

        await expect(service.getEncryptionFloor(CONTEXT)).resolves.toBeNull();
    });
});
