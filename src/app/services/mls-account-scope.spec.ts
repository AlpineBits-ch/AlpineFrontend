/**
 * That two accounts on one machine cannot see each other's key material or history.
 *
 * <p><b>The leak this closes.</b> Every local MLS store was named for the installation, never for
 * the account: one `mls_state.json`, one `mls-group-registry.json`, one `mls-message-cache.json`,
 * and keychain entries under a device id that was also per-installation. Signing out through a path
 * that did not wipe - which was most of them - and signing in as somebody else therefore loaded the
 * previous account's signing key, its context-to-group mappings and its <i>plaintext message
 * history</i> into the new session. The cache seal key is derived per device, so none of it even
 * failed to open.</p>
 *
 * <p>The fix is entirely in the naming: the device id is per account, and every store name is
 * derived from it. These tests drive the seam from the store side; `device-identity.service.spec.ts`
 * drives it from the id side.</p>
 */
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
    isTauri: vi.fn(() => true),
}));
vi.mock('tauri-plugin-secure-storage-api', () => ({
    secureStorage: {
        getItem: vi.fn(),
        setItem: vi.fn(async () => undefined),
        removeItem: vi.fn(async () => undefined),
    },
}));
vi.mock('@tauri-apps/plugin-store', () => ({
    // One backing map per filename, shared across constructions, so "did these two accounts read
    // the same file" is a question this stub can actually answer.
    LazyStore: class LazyStoreStub {
        static readonly files = new Map<string, Map<string, unknown>>();
        static readonly opened: string[] = [];

        private readonly values: Map<string, unknown>;

        constructor(file: string) {
            LazyStoreStub.opened.push(file);
            const existing = LazyStoreStub.files.get(file);
            this.values = existing ?? new Map<string, unknown>();
            LazyStoreStub.files.set(file, this.values);
        }

        async get<T>(key: string) { return this.values.get(key) as T | undefined; }
        async set(key: string, value: unknown) { this.values.set(key, value); }
        async delete(key: string) { this.values.delete(key); }
        async entries<T>() { return [...this.values.entries()] as [string, T][]; }
        async clear() { this.values.clear(); }
        async save() { }
    },
}));

import {TestBed} from '@angular/core/testing';
import {firstValueFrom} from 'rxjs';
import {invoke} from '@tauri-apps/api/core';
import {LazyStore} from '@tauri-apps/plugin-store';
import {secureStorage} from 'tauri-plugin-secure-storage-api';
import {MlsService, MlsTypedError} from './mls.service';
import {DeviceIdentityService} from './device-identity.service';

const LazyStoreMock = LazyStore as unknown as {
    files: Map<string, Map<string, unknown>>;
    opened: string[];
};
const invokeStub = vi.mocked(invoke);
const getItem = vi.mocked(secureStorage.getItem);

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
    LazyStoreMock.files.clear();
    LazyStoreMock.opened.length = 0;
    invokeStub.mockReset();
    getItem.mockReset();
    keychainPerDevice();
});

describe('per-account store naming', () => {
    it('names the group registry and message cache after this account device', async () => {
        const service = build(DEVICE_A);
        await service.registerGroup('ctx-1', 0, 'Z3JvdXA=');

        expect(LazyStoreMock.opened).toContain(`mls-group-registry-${DEVICE_A}.json`);
        expect(LazyStoreMock.opened).not.toContain('mls-group-registry.json');
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

        // KeyNotFound routes to the registration modal, which mints a *fresh* signing key and
        // permanently orphans the device from every group it belongs to. A mismatch is the one
        // case where that would be catastrophic and also entirely unnecessary.
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

        // Not every caller has a user id to hand. Refusing those would break the paths that
        // legitimately unlock before the account is known.
        await expect(firstValueFrom(service.autoUnlock(DEVICE_A))).resolves.toBe('handle-1');
    });
});
