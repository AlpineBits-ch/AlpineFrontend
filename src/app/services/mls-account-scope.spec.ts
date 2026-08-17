/** Two accounts on one machine must not share key material: the device id is per account, and names every store. */
import {TestBed} from '@angular/core/testing';
import {firstValueFrom} from 'rxjs';
import {MlsEngine} from '../platform/ports/mls-engine.port';
import {MlsLocalStoreFactory} from '../platform/ports/mls-local-store.port';
import {SecureStore} from '../platform/ports/secure-store.port';
import {FakeMlsEngine} from '../platform/testing/fake-mls-engine';
import {FakeMlsLocalStoreFactory} from '../platform/testing/fake-mls-local-store';
import {MlsService, MlsTypedError} from './mls.service';
import {DeviceIdentityService} from './device-identity.service';

/** One factory instance across every `build()`: one backing map per file name is what makes the leak testable. */
const localStores = new FakeMlsLocalStoreFactory();
const invokeStub = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();
const engine = new FakeMlsEngine();

class StubSecureStore extends SecureStore {
    readonly hardwareBacked = true;
    getItem = vi.fn(async (_key: string): Promise<string | null> => null);
    setItem = vi.fn(async (_key: string, _value: string): Promise<void> => undefined);
    removeItem = vi.fn(async (_key: string): Promise<void> => undefined);
}

const secureStore = new StubSecureStore();
const getItem = secureStore.getItem;

const DEVICE_A = 'device-for-account-a';
const DEVICE_B = 'device-for-account-b';

/** The device id is the account boundary, so it is the thing these tests vary. */
class DeviceIdentityStub {
    constructor(public id: string, public ownsLegacy = false) { }
    async deviceId(): Promise<string> { return this.id; }
    async ownsLegacyState(): Promise<boolean> { return this.ownsLegacy; }
}

let identity: DeviceIdentityStub;

function build(deviceId: string): MlsService {
    identity = new DeviceIdentityStub(deviceId);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            MlsService,
            {provide: MlsEngine, useValue: engine},
            {provide: SecureStore, useValue: secureStore},
            // One factory across every build(), so a second account genuinely opens different files.
            {provide: MlsLocalStoreFactory, useValue: localStores},
            {provide: DeviceIdentityService, useValue: identity},
        ],
    });
    return TestBed.inject(MlsService);
}

/** A distinct 32-byte state key per device, so a cache sealed for A cannot open under B. */
function keychainPerDevice(): void {
    const keys = new Map<string, string>();
    getItem.mockImplementation(async (name: string) => {
        if (name.endsWith('_statekey')) {
            if (!keys.has(name)) {
                keys.set(name, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'));
            }
            return keys.get(name)!;
        }
        return null;
    });
}

beforeEach(() => {
    localStores.reset();
    invokeStub.mockReset();
    engine.reset();
    engine.handler = invokeStub;
    getItem.mockReset();
    keychainPerDevice();
});

describe('per-account store naming', () => {
    it('names the group registry and message cache after this account device', async () => {
        const service = build(DEVICE_A);
        await service.registerGroup('ctx-1', 0, 'Z3JvdXA=');

        expect(localStores.opened).toContain(`mls-group-registry-${DEVICE_A}.json`);
        expect(localStores.opened).not.toContain('mls-group-registry.json');
    });

    it('passes this account scope to the engine, so the state file is its own', async () => {
        const service = build(DEVICE_A);
        invokeStub.mockResolvedValue(true as never);

        await firstValueFrom(service.initStorage());

        const [command, args] = invokeStub.mock.calls[0] as [string, Record<string, unknown>];
        expect(command).toBe('mls_init_storage');
        expect(args['scope']).toBe(DEVICE_A);
        expect(args['stateKeyB64']).toBeTruthy();
    });

    it('tells the engine to adopt the pre-scope state file only for the account that owns it', async () => {
        const service = build(DEVICE_A);
        identity.ownsLegacy = true;
        invokeStub.mockResolvedValue(true as never);

        await firstValueFrom(service.initStorage());

        expect((invokeStub.mock.calls[0][1] as Record<string, unknown>)['adoptLegacy']).toBe(true);
    });

    it('does not tell the engine to adopt it for an account that does not', async () => {
        const service = build(DEVICE_B);
        invokeStub.mockResolvedValue(true as never);

        await firstValueFrom(service.initStorage());

        expect((invokeStub.mock.calls[0][1] as Record<string, unknown>)['adoptLegacy']).toBe(false);
    });
});

describe('the cross-account leak', () => {
    it('does not show account A group registry to account B', async () => {
        const a = build(DEVICE_A);
        await a.registerGroup('ctx-1', 3, 'Z3JvdXA=');
        expect(await a.getGroupId('ctx-1', 3)).toBe('Z3JvdXA=');

        const b = build(DEVICE_B);

        expect(await b.getGroupId('ctx-1', 3)).toBeNull();
        expect(await b.getKnownGeneration('ctx-1')).toBeNull();
    });

    it('does not show account A encryption floor to account B', async () => {
        const a = build(DEVICE_A);
        await a.registerGroup('ctx-1', 5, 'Z3JvdXA=');
        expect(await a.getEncryptionFloor('ctx-1')).toBe(5);

        const b = build(DEVICE_B);

        expect(await b.getEncryptionFloor('ctx-1')).toBeNull();
    });

    it('does not let account B read account A plaintext message history', async () => {
        const a = build(DEVICE_A);
        await a.cacheMessage('ctx-1', 0, 'msg-1', 'c2VjcmV0', 'user-a');
        expect(await a.getCachedMessage('ctx-1', 0, 'msg-1', 'user-a')).toBe('c2VjcmV0');

        const b = build(DEVICE_B);

        expect(await b.getCachedMessage('ctx-1', 0, 'msg-1', 'user-a')).toBeNull();
    });

    it('gives each account its own file rather than one they take turns overwriting', async () => {
        const a = build(DEVICE_A);
        await a.registerGroup('ctx-1', 1, 'YQ==');

        const b = build(DEVICE_B);
        await b.registerGroup('ctx-1', 1, 'Yg==');

        // A's mapping survives B writing its own for the same context.
        const backToA = build(DEVICE_A);
        expect(await backToA.getGroupId('ctx-1', 1)).toBe('YQ==');
    });

    it('wipes only the account that asked, not the other one on this machine', async () => {
        const a = build(DEVICE_A);
        await a.registerGroup('ctx-1', 1, 'YQ==');
        await a.cacheMessage('ctx-1', 1, 'msg-1', 'aGk=', 'user-a');

        const b = build(DEVICE_B);
        await b.registerGroup('ctx-2', 1, 'Yg==');
        await b.clearGroupRegistry();
        await b.clearMessageCache();

        const backToA = build(DEVICE_A);
        expect(await backToA.getGroupId('ctx-1', 1)).toBe('YQ==');
        expect(await backToA.getCachedMessage('ctx-1', 1, 'msg-1', 'user-a')).toBe('aGk=');
    });
});

describe('autoUnlock identity guard', () => {
    /** Puts a full keychain entry set for `identityUserId` under `deviceId`. */
    function keychainHolding(deviceId: string, identityUserId: string): void {
        getItem.mockImplementation(async (name: string) => {
            if (name === `alpine_mls_${deviceId}_pub`) return 'cHVi';
            if (name === `alpine_mls_${deviceId}_priv`) return 'cHJpdg==';
            if (name === `alpine_mls_${deviceId}_identity`) return identityUserId;
            if (name.endsWith('_statekey')) return Buffer.alloc(32).toString('base64');
            return null;
        });
    }

    it('unlocks when the stored identity is the signed-in user', async () => {
        const service = build(DEVICE_A);
        keychainHolding(DEVICE_A, 'user-a');
        invokeStub.mockResolvedValue('handle-1' as never);

        await expect(firstValueFrom(service.autoUnlock(DEVICE_A, 'user-a')))
            .resolves.toBe('handle-1');
    });

    it('refuses to hand account B a signing key stored for account A', async () => {
        const service = build(DEVICE_A);
        keychainHolding(DEVICE_A, 'user-a');
        invokeStub.mockResolvedValue('handle-1' as never);

        await expect(firstValueFrom(service.autoUnlock(DEVICE_A, 'user-b'))).rejects.toMatchObject({
            kind: 'IdentityMismatch',
        });
        expect(invokeStub).not.toHaveBeenCalled();
    });

    it('reports a mismatch as IdentityMismatch and never as KeyNotFound', async () => {
        const service = build(DEVICE_A);
        keychainHolding(DEVICE_A, 'user-a');

        // KeyNotFound routes to registration, which mints a fresh key and orphans the device from every group.
        const err = await firstValueFrom(service.autoUnlock(DEVICE_A, 'user-b'))
            .catch((e: MlsTypedError) => e);

        expect((err as MlsTypedError).kind).not.toBe('KeyNotFound');
        expect((err as MlsTypedError).kind).toBe('IdentityMismatch');
    });

    it('still reports a genuinely empty keychain as KeyNotFound', async () => {
        const service = build(DEVICE_A);
        getItem.mockResolvedValue(null);

        await expect(firstValueFrom(service.autoUnlock(DEVICE_A, 'user-a'))).rejects.toMatchObject({
            kind: 'KeyNotFound',
        });
    });

    it('unlocks without a check when the caller does not know who is signed in', async () => {
        const service = build(DEVICE_A);
        keychainHolding(DEVICE_A, 'user-a');
        invokeStub.mockResolvedValue('handle-1' as never);

        // Not every caller has a user id to hand; refusing those breaks unlocks before the account is known.
        await expect(firstValueFrom(service.autoUnlock(DEVICE_A))).resolves.toBe('handle-1');
    });
});
