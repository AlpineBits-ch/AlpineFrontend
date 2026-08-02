/**
 * Exhaustive unit tests for MlsService.
 * Test runner: Vitest (via @angular/build:unit-test)
 *
 * Strategy
 * ─────────
 * The service is a thin adapter over Tauri's `invoke`. Every method must:
 *   1. Call `invoke` with the correct snake_case command name.
 *   2. Pass each argument under the exact camelCase key that Rust's
 *      `#[serde(rename_all = "camelCase")]` expects.
 *   3. Return an Observable that resolves to the value `invoke` resolves to.
 *   4. Surface any rejection from `invoke` as an Observable error.
 */
// `isTauri` is stubbed true because these tests exercise the in-Tauri path. The fail-closed guard
// that depends on it has its own tests - see "outside Tauri" at the end of this file.
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
    isTauri: vi.fn(() => true),
}));
vi.mock('tauri-plugin-secure-storage-api', () => ({
    secureStorage: {
        getItem: vi.fn(async () => 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
        setItem: vi.fn(async () => undefined),
        removeItem: vi.fn(async () => undefined),
    },
}));
vi.mock('@tauri-apps/plugin-store', () => ({
    LazyStore: class {
        private readonly values = new Map<string, unknown>();
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
import {invoke, isTauri} from '@tauri-apps/api/core';

import {
    KeyPackageResult,
    MlsCommitOut,
    MlsGroupInfo,
    MlsKeyPackageBatch,
    MlsMemberInfo,
    MlsProcessedMessage,
    MlsRejoinOut,
    MlsFeatureUnavailableError,
    MlsService,
    parseMlsError,
} from './mls.service';

// ---------------------------------------------------------------------------
// Module mock -must be a top-level call so Vitest hoists it before imports
// ---------------------------------------------------------------------------

const invokeStub = vi.mocked(invoke);

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const KEY_HANDLE = 'test-handle-uuid-1234';

const MEMBER_ALICE: MlsMemberInfo = {
    leafIndex: 0,
    identity: 'alice',
    encryptionKey: 'aGVsbG8=',
    signatureKey: 'd29ybGQ=',
};

const MEMBER_BOB: MlsMemberInfo = {
    leafIndex: 2,
    identity: 'bob',
    encryptionKey: 'Ym9iZW5j',
    signatureKey: 'Ym9ic2ln',
};

const GROUP_INFO: MlsGroupInfo = {
    groupId: 'Z3JvdXAxMjM=',
    epoch: 0,
    ownLeafIndex: 0,
    members: [MEMBER_ALICE],
};

const KEY_PKG_RESULT: KeyPackageResult = {
    keyPackage: 'a2V5cGtn',
    initPrivateKey: 'aW5pdHByaXY=',
};

const KEY_PKG_BATCH: MlsKeyPackageBatch = {
    signingPublicKey: 'cHVia2V5',
    signingPrivateKey: 'cHJpdmtleQ==',
    keyPackages: [KEY_PKG_RESULT],
    keyHandle: KEY_HANDLE,
};

const COMMIT_WITH_WELCOME: MlsCommitOut = {
    commit: 'Y29tbWl0',
    welcome: 'd2VsY29tZQ==',
    epoch: 1,
    groupInfo: null
};

const COMMIT_NO_WELCOME: MlsCommitOut = {
    commit: 'Y29tbWl0',
    welcome: null,
    epoch: 2,
    groupInfo: null
};

const APP_MESSAGE: MlsProcessedMessage = {
    kind: 'application',
    plaintext: 'aGVsbG8gd29ybGQ=',
    selfRemoved: false,
    addedMembers: [],
    removedLeafIndices: [],
    senderIdentity: 'alice',
    epoch: null,
};

const COMMIT_MESSAGE: MlsProcessedMessage = {
    kind: 'commit',
    plaintext: null,
    selfRemoved: false,
    addedMembers: [MEMBER_BOB],
    removedLeafIndices: [],
    senderIdentity: 'alice',
    epoch: 1,
};

const REMOVAL_COMMIT_MESSAGE: MlsProcessedMessage = {
    kind: 'commit',
    plaintext: null,
    selfRemoved: false,
    addedMembers: [],
    removedLeafIndices: [2],
    senderIdentity: 'alice',
    epoch: 2,
};

const SELF_REMOVAL_COMMIT: MlsProcessedMessage = {
    kind: 'commit',
    plaintext: null,
    selfRemoved: true,
    addedMembers: [],
    removedLeafIndices: [0],
    senderIdentity: 'alice',
    epoch: 3,
};

const PROPOSAL_MESSAGE: MlsProcessedMessage = {
    kind: 'proposal',
    plaintext: null,
    selfRemoved: false,
    addedMembers: [],
    removedLeafIndices: [],
    senderIdentity: 'charlie',
    epoch: null,
};

const REJOIN_OUT: MlsRejoinOut = {
    groupInfo: {...GROUP_INFO, ownLeafIndex: 2},
    externalCommit: 'ZXh0Q29tbWl0',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockInvoke<T>(result: T): void {
    invokeStub.mockResolvedValue(result as never);
}

function mockInvokeReject(message: string): void {
    invokeStub.mockRejectedValue(message);
}

/** Shorthand to get the args object passed to invoke on call index n. */
function callArgs(n = 0): Record<string, unknown> {
    return invokeStub.mock.calls[n][1] as Record<string, unknown>;
}

/** Shorthand to get the command name passed to invoke on call index n. */
function callCmd(n = 0): string {
    return invokeStub.mock.calls[n][0] as string;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('MlsService', () => {
    let service: MlsService;

    beforeEach(() => {
        invokeStub.mockReset();
        TestBed.configureTestingModule({providers: [MlsService]});
        service = TestBed.inject(MlsService);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Service instantiation
    // ─────────────────────────────────────────────────────────────────────────

    describe('instantiation', () => {
        it('should be created via TestBed', () => {
            expect(service).toBeTruthy();
        });

        it('should be provided in root (singleton)', () => {
            const service2 = TestBed.inject(MlsService);
            expect(service).toBe(service2);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // parseMlsError utility
    // ─────────────────────────────────────────────────────────────────────────

    describe('parseMlsError', () => {
        it('parses WrongEpoch prefix', () => {
            const err = parseMlsError('WrongEpoch: epoch is 3 but expected 2');
            expect(err.kind).toBe('WrongEpoch');
            expect(err.message).toContain('epoch');
        });

        it('parses UnknownSender prefix', () => {
            const err = parseMlsError('UnknownSender: alice not in roster');
            expect(err.kind).toBe('UnknownSender');
        });

        it('parses ValidationError prefix', () => {
            const err = parseMlsError('ValidationError: bad signature');
            expect(err.kind).toBe('ValidationError');
        });

        it('parses GroupNotFound prefix', () => {
            const err = parseMlsError('GroupNotFound: group not found');
            expect(err.kind).toBe('GroupNotFound');
        });

        it('parses KeyNotFound prefix', () => {
            const err = parseMlsError('KeyNotFound: no signing key loaded');
            expect(err.kind).toBe('KeyNotFound');
        });

        it('falls back to MlsError for unknown strings', () => {
            const err = parseMlsError('some unexpected error');
            expect(err.kind).toBe('MlsError');
            expect(err.message).toBe('some unexpected error');
        });

        it('handles non-string input', () => {
            const err = parseMlsError({code: 42});
            expect(err.kind).toBe('MlsError');
        });

        it('parses kind:message with no space after colon', () => {
            const err = parseMlsError('WrongEpoch:no space here');
            expect(err.kind).toBe('WrongEpoch');
            expect(err.message).toBe('no space here');
        });

        it('does not match when kind appears mid-string', () => {
            const err = parseMlsError('wrapped WrongEpoch: in sentence');
            expect(err.kind).toBe('MlsError');
        });

        it('falls back to MlsError for empty string', () => {
            const err = parseMlsError('');
            expect(err.kind).toBe('MlsError');
            expect(err.message).toBe('');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // loadSigningKey
    // ─────────────────────────────────────────────────────────────────────────

    describe('loadSigningKey', () => {
        const PUB = 'cHVia2V5';
        const PRIV = 'cHJpdmtleQ==';

        it('returns an Observable', () => {
            mockInvoke(KEY_HANDLE);
            const result = service.loadSigningKey(PUB, PRIV, 'alice');
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe).toBe('function');
        });

        it('calls invoke with command "mls_load_signing_key"', async () => {
            mockInvoke(KEY_HANDLE);
            await firstValueFrom(service.loadSigningKey(PUB, PRIV, 'alice'));
            expect(callCmd()).toBe('mls_load_signing_key');
        });

        it('passes signingPublicKeyB64', async () => {
            mockInvoke(KEY_HANDLE);
            await firstValueFrom(service.loadSigningKey(PUB, PRIV, 'alice'));
            expect(callArgs()['signingPublicKeyB64']).toBe(PUB);
        });

        it('passes signingPrivateKeyB64', async () => {
            mockInvoke(KEY_HANDLE);
            await firstValueFrom(service.loadSigningKey(PUB, PRIV, 'alice'));
            expect(callArgs()['signingPrivateKeyB64']).toBe(PRIV);
        });

        it('passes identity', async () => {
            mockInvoke(KEY_HANDLE);
            await firstValueFrom(service.loadSigningKey(PUB, PRIV, 'alice'));
            expect(callArgs()['identity']).toBe('alice');
        });

        it('passes exactly 3 keys to invoke', async () => {
            mockInvoke(KEY_HANDLE);
            await firstValueFrom(service.loadSigningKey(PUB, PRIV, 'alice'));
            expect(Object.keys(callArgs()).sort()).toEqual(
                ['identity', 'signingPrivateKeyB64', 'signingPublicKeyB64'].sort(),
            );
        });

        it('resolves with the opaque handle string', async () => {
            mockInvoke(KEY_HANDLE);
            const handle = await firstValueFrom(service.loadSigningKey(PUB, PRIV, 'alice'));
            expect(handle).toBe(KEY_HANDLE);
        });

        it('propagates invoke rejection', async () => {
            mockInvokeReject('bad key bytes');
            await expect(
                firstValueFrom(service.loadSigningKey(PUB, PRIV, 'alice')),
            ).rejects.toBe('bad key bytes');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // unloadSigningKey
    // ─────────────────────────────────────────────────────────────────────────

    describe('unloadSigningKey', () => {
        it('returns an Observable', () => {
            mockInvoke(undefined);
            const result = service.unloadSigningKey(KEY_HANDLE);
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe).toBe('function');
        });

        it('calls invoke with command "mls_unload_signing_key"', async () => {
            mockInvoke(undefined);
            await firstValueFrom(service.unloadSigningKey(KEY_HANDLE));
            expect(callCmd()).toBe('mls_unload_signing_key');
        });

        it('passes keyHandle', async () => {
            mockInvoke(undefined);
            await firstValueFrom(service.unloadSigningKey(KEY_HANDLE));
            expect(callArgs()['keyHandle']).toBe(KEY_HANDLE);
        });

        it('passes exactly 1 key to invoke', async () => {
            mockInvoke(undefined);
            await firstValueFrom(service.unloadSigningKey(KEY_HANDLE));
            expect(Object.keys(callArgs())).toEqual(['keyHandle']);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // generateKeyPackages
    // ─────────────────────────────────────────────────────────────────────────

    describe('generateKeyPackages', () => {
        it('returns an Observable (not a Promise)', () => {
            mockInvoke(KEY_PKG_BATCH);
            const result = service.generateKeyPackages('alice', 3);
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe)
                .toBe('function');
        });

        it('calls invoke with the correct command name', async () => {
            mockInvoke(KEY_PKG_BATCH);
            await firstValueFrom(service.generateKeyPackages('alice', 1));
            expect(invokeStub).toHaveBeenCalledWith(
                'generate_mls_key_packages',
                expect.any(Object),
            );
        });

        it('passes identity as "identity"', async () => {
            mockInvoke(KEY_PKG_BATCH);
            await firstValueFrom(service.generateKeyPackages('alice@example.com', 1));
            expect(callArgs()['identity']).toBe('alice@example.com');
        });

        it('passes count as "count"', async () => {
            mockInvoke(KEY_PKG_BATCH);
            await firstValueFrom(service.generateKeyPackages('alice', 5));
            expect(callArgs()['count']).toBe(5);
        });

        it('passes count = 0 through unmodified', async () => {
            mockInvoke({...KEY_PKG_BATCH, keyPackages: []});
            await firstValueFrom(service.generateKeyPackages('alice', 0));
            expect(callArgs()['count']).toBe(0);
        });

        it('resolves with the batch from invoke', async () => {
            mockInvoke(KEY_PKG_BATCH);
            const batch = await firstValueFrom(service.generateKeyPackages('alice', 1));
            expect(batch).toEqual(KEY_PKG_BATCH);
        });

        it('exposes signingPublicKey on the batch', async () => {
            mockInvoke(KEY_PKG_BATCH);
            const batch = await firstValueFrom(service.generateKeyPackages('alice', 1));
            expect(batch.signingPublicKey).toBe(KEY_PKG_BATCH.signingPublicKey);
        });

        it('exposes signingPrivateKey on the batch', async () => {
            mockInvoke(KEY_PKG_BATCH);
            const batch = await firstValueFrom(service.generateKeyPackages('alice', 1));
            expect(batch.signingPrivateKey).toBe(KEY_PKG_BATCH.signingPrivateKey);
        });

        it('exposes keyHandle on the batch', async () => {
            mockInvoke(KEY_PKG_BATCH);
            const batch = await firstValueFrom(service.generateKeyPackages('alice', 1));
            expect(batch.keyHandle).toBe(KEY_HANDLE);
        });

        it('exposes keyPackages array on the batch', async () => {
            mockInvoke(KEY_PKG_BATCH);
            const batch = await firstValueFrom(service.generateKeyPackages('alice', 1));
            expect(batch.keyPackages).toEqual([KEY_PKG_RESULT]);
        });

        it('each KeyPackageResult has keyPackage and initPrivateKey', async () => {
            const multi: MlsKeyPackageBatch = {
                ...KEY_PKG_BATCH,
                keyPackages: [
                    {keyPackage: 'a2V5MA==', initPrivateKey: 'aW5pdDA='},
                    {keyPackage: 'a2V5MQ==', initPrivateKey: 'aW5pdDE='},
                ],
            };
            mockInvoke(multi);
            const batch = await firstValueFrom(service.generateKeyPackages('alice', 2));
            expect(batch.keyPackages.length).toBe(2);
            expect(batch.keyPackages[0].keyPackage).toBe('a2V5MA==');
            expect(batch.keyPackages[1].initPrivateKey).toBe('aW5pdDE=');
        });

        it('propagates invoke rejection as an Observable error', async () => {
            mockInvokeReject('crypto error');
            await expect(
                firstValueFrom(service.generateKeyPackages('alice', 1)),
            ).rejects.toBe('crypto error');
        });

        it('passes identity with special characters verbatim', async () => {
            mockInvoke(KEY_PKG_BATCH);
            await firstValueFrom(service.generateKeyPackages('alice+tag@example.com', 1));
            expect(callArgs()['identity']).toBe('alice+tag@example.com');
        });

        it('passes large count correctly', async () => {
            mockInvoke({...KEY_PKG_BATCH, keyPackages: []});
            await firstValueFrom(service.generateKeyPackages('alice', 100));
            expect(callArgs()['count']).toBe(100);
        });

        it('each method call triggers a new invoke call', async () => {
            mockInvoke(KEY_PKG_BATCH);
            await firstValueFrom(service.generateKeyPackages('alice', 1));
            await firstValueFrom(service.generateKeyPackages('alice', 1));
            expect(invokeStub).toHaveBeenCalledTimes(2);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // generateAdditionalKeyPackages
    // ─────────────────────────────────────────────────────────────────────────

    describe('generateAdditionalKeyPackages', () => {
        it('returns an Observable', () => {
            mockInvoke([KEY_PKG_RESULT]);
            const result = service.generateAdditionalKeyPackages(KEY_HANDLE, 1);
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe).toBe('function');
        });

        it('calls invoke with command "mls_generate_key_packages_with_handle"', async () => {
            mockInvoke([KEY_PKG_RESULT]);
            await firstValueFrom(service.generateAdditionalKeyPackages(KEY_HANDLE, 3));
            expect(callCmd()).toBe('mls_generate_key_packages_with_handle');
        });

        it('passes keyHandle as "keyHandle"', async () => {
            mockInvoke([KEY_PKG_RESULT]);
            await firstValueFrom(service.generateAdditionalKeyPackages(KEY_HANDLE, 1));
            expect(callArgs()['keyHandle']).toBe(KEY_HANDLE);
        });

        it('passes count as "count"', async () => {
            mockInvoke([KEY_PKG_RESULT]);
            await firstValueFrom(service.generateAdditionalKeyPackages(KEY_HANDLE, 5));
            expect(callArgs()['count']).toBe(5);
        });

        it('passes exactly 2 keys to invoke (keyHandle and count)', async () => {
            mockInvoke([KEY_PKG_RESULT]);
            await firstValueFrom(service.generateAdditionalKeyPackages(KEY_HANDLE, 1));
            expect(Object.keys(callArgs()).sort()).toEqual(['count', 'keyHandle'].sort());
        });

        it('resolves with the KeyPackageResult array from invoke', async () => {
            mockInvoke([KEY_PKG_RESULT]);
            const result = await firstValueFrom(service.generateAdditionalKeyPackages(KEY_HANDLE, 1));
            expect(result).toEqual([KEY_PKG_RESULT]);
        });

        it('each KeyPackageResult has keyPackage and initPrivateKey fields', async () => {
            const multi = [
                {keyPackage: 'a2V5MA==', initPrivateKey: 'aW5pdDA='},
                {keyPackage: 'a2V5MQ==', initPrivateKey: 'aW5pdDE='},
            ];
            mockInvoke(multi);
            const result = await firstValueFrom(service.generateAdditionalKeyPackages(KEY_HANDLE, 2));
            expect(result.length).toBe(2);
            expect(result[0].keyPackage).toBe('a2V5MA==');
            expect(result[1].initPrivateKey).toBe('aW5pdDE=');
        });

        it('passes count = 0 through unmodified', async () => {
            mockInvoke([]);
            await firstValueFrom(service.generateAdditionalKeyPackages(KEY_HANDLE, 0));
            expect(callArgs()['count']).toBe(0);
        });

        it('result array does not include signingPrivateKey (no key rotation)', async () => {
            mockInvoke([KEY_PKG_RESULT]);
            const result = await firstValueFrom(service.generateAdditionalKeyPackages(KEY_HANDLE, 1));
            expect(result.every(r => !('signingPrivateKey' in r))).toBe(true);
        });

        it('propagates invoke rejection', async () => {
            mockInvokeReject('KeyNotFound: no signing key loaded for handle');
            await expect(
                firstValueFrom(service.generateAdditionalKeyPackages(KEY_HANDLE, 1)),
            ).rejects.toBe('KeyNotFound: no signing key loaded for handle');
        });

        it('each call triggers a fresh invoke', async () => {
            mockInvoke([KEY_PKG_RESULT]);
            await firstValueFrom(service.generateAdditionalKeyPackages(KEY_HANDLE, 1));
            await firstValueFrom(service.generateAdditionalKeyPackages(KEY_HANDLE, 1));
            expect(invokeStub).toHaveBeenCalledTimes(2);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // createGroup
    // ─────────────────────────────────────────────────────────────────────────

    describe('createGroup', () => {
        const GID = 'Z3JvdXAxMjM=';

        it('returns an Observable', () => {
            mockInvoke(GROUP_INFO);
            const result = service.createGroup(GID, KEY_HANDLE);
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe)
                .toBe('function');
        });

        it('calls invoke with command "mls_create_group"', async () => {
            mockInvoke(GROUP_INFO);
            await firstValueFrom(service.createGroup(GID, KEY_HANDLE));
            expect(callCmd()).toBe('mls_create_group');
        });

        it('passes groupIdB64 as "groupIdB64"', async () => {
            mockInvoke(GROUP_INFO);
            await firstValueFrom(service.createGroup(GID, KEY_HANDLE));
            expect(callArgs()['groupIdB64']).toBe(GID);
        });

        it('passes keyHandle as "keyHandle"', async () => {
            mockInvoke(GROUP_INFO);
            await firstValueFrom(service.createGroup(GID, KEY_HANDLE));
            expect(callArgs()['keyHandle']).toBe(KEY_HANDLE);
        });

        it('passes exactly 2 keys to invoke (no raw key material)', async () => {
            mockInvoke(GROUP_INFO);
            await firstValueFrom(service.createGroup(GID, KEY_HANDLE));
            expect(Object.keys(callArgs()).sort()).toEqual(['groupIdB64', 'keyHandle'].sort());
        });

        it('resolves with MlsGroupInfo from invoke', async () => {
            mockInvoke(GROUP_INFO);
            const info = await firstValueFrom(service.createGroup(GID, KEY_HANDLE));
            expect(info).toEqual(GROUP_INFO);
        });

        it('groupInfo.epoch starts at 0 for a new group', async () => {
            mockInvoke({...GROUP_INFO, epoch: 0});
            const info = await firstValueFrom(service.createGroup(GID, KEY_HANDLE));
            expect(info.epoch).toBe(0);
        });

        it('groupInfo.ownLeafIndex is 0 for the creator', async () => {
            mockInvoke({...GROUP_INFO, ownLeafIndex: 0});
            const info = await firstValueFrom(service.createGroup(GID, KEY_HANDLE));
            expect(info.ownLeafIndex).toBe(0);
        });

        it('groupInfo.members contains at least the creator', async () => {
            mockInvoke({...GROUP_INFO, members: [MEMBER_ALICE]});
            const info = await firstValueFrom(service.createGroup(GID, KEY_HANDLE));
            expect(info.members.length).toBeGreaterThanOrEqual(1);
        });

        it('propagates invoke rejection', async () => {
            mockInvokeReject('group already exists');
            await expect(
                firstValueFrom(service.createGroup(GID, KEY_HANDLE)),
            ).rejects.toBe('group already exists');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // addMembers
    // ─────────────────────────────────────────────────────────────────────────

    describe('addMembers', () => {
        const GID = 'Z3JvdXAxMjM=';
        const KPS = ['a2V5cGtnMQ==', 'a2V5cGtnMg=='];

        it('returns an Observable', () => {
            mockInvoke(COMMIT_WITH_WELCOME);
            const result = service.addMembers(GID, KEY_HANDLE, KPS);
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe)
                .toBe('function');
        });

        it('calls invoke with command "mls_add_members"', async () => {
            mockInvoke(COMMIT_WITH_WELCOME);
            await firstValueFrom(service.addMembers(GID, KEY_HANDLE, KPS));
            expect(callCmd()).toBe('mls_add_members');
        });

        it('passes groupIdB64 as "groupIdB64"', async () => {
            mockInvoke(COMMIT_WITH_WELCOME);
            await firstValueFrom(service.addMembers(GID, KEY_HANDLE, KPS));
            expect(callArgs()['groupIdB64']).toBe(GID);
        });

        it('passes keyHandle as "keyHandle"', async () => {
            mockInvoke(COMMIT_WITH_WELCOME);
            await firstValueFrom(service.addMembers(GID, KEY_HANDLE, KPS));
            expect(callArgs()['keyHandle']).toBe(KEY_HANDLE);
        });

        it('passes keyPackagesB64 array as "keyPackagesB64"', async () => {
            mockInvoke(COMMIT_WITH_WELCOME);
            await firstValueFrom(service.addMembers(GID, KEY_HANDLE, KPS));
            expect(callArgs()['keyPackagesB64']).toEqual(KPS);
        });

        it('passes exactly 3 keys to invoke (no raw key material)', async () => {
            mockInvoke(COMMIT_WITH_WELCOME);
            await firstValueFrom(service.addMembers(GID, KEY_HANDLE, KPS));
            expect(Object.keys(callArgs()).sort()).toEqual(
                ['groupIdB64', 'keyHandle', 'keyPackagesB64'].sort(),
            );
        });

        it('resolves with MlsCommitOut from invoke', async () => {
            mockInvoke(COMMIT_WITH_WELCOME);
            const result = await firstValueFrom(service.addMembers(GID, KEY_HANDLE, KPS));
            expect(result).toEqual(COMMIT_WITH_WELCOME);
        });

        it('commit field is always a non-empty string', async () => {
            mockInvoke(COMMIT_WITH_WELCOME);
            const result = await firstValueFrom(service.addMembers(GID, KEY_HANDLE, KPS));
            expect(result.commit.length).toBeGreaterThan(0);
        });

        it('welcome field is non-null when members were added', async () => {
            mockInvoke(COMMIT_WITH_WELCOME);
            const result = await firstValueFrom(service.addMembers(GID, KEY_HANDLE, KPS));
            expect(result.welcome).not.toBeNull();
        });

        it('welcome field can be null (e.g. no new members scenario)', async () => {
            mockInvoke(COMMIT_NO_WELCOME);
            const result = await firstValueFrom(service.addMembers(GID, KEY_HANDLE, []));
            expect(result.welcome).toBeNull();
        });

        it('epoch is present and is a number', async () => {
            mockInvoke(COMMIT_WITH_WELCOME);
            const result = await firstValueFrom(service.addMembers(GID, KEY_HANDLE, KPS));
            expect(typeof result.epoch).toBe('number');
        });

        it('handles an empty keyPackagesB64 array', async () => {
            mockInvoke(COMMIT_NO_WELCOME);
            await firstValueFrom(service.addMembers(GID, KEY_HANDLE, []));
            expect(callArgs()['keyPackagesB64']).toEqual([]);
        });

        it('preserves all key packages in the array', async () => {
            const threeKps = ['a==', 'b==', 'c=='];
            mockInvoke(COMMIT_WITH_WELCOME);
            await firstValueFrom(service.addMembers(GID, KEY_HANDLE, threeKps));
            expect(callArgs()['keyPackagesB64']).toEqual(threeKps);
        });

        it('propagates invoke rejection', async () => {
            mockInvokeReject('group not found');
            await expect(
                firstValueFrom(service.addMembers(GID, KEY_HANDLE, KPS)),
            ).rejects.toBe('group not found');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // joinGroup
    // ─────────────────────────────────────────────────────────────────────────

    describe('joinGroup', () => {
        const WELCOME = 'd2VsY29tZQ==';

        const JOINED_GROUP: MlsGroupInfo = {
            groupId: 'Z3JvdXAxMjM=',
            epoch: 0,
            ownLeafIndex: 2,
            members: [MEMBER_ALICE, MEMBER_BOB],
        };

        it('returns an Observable', () => {
            mockInvoke(JOINED_GROUP);
            const result = service.joinGroup(WELCOME, KEY_HANDLE);
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe)
                .toBe('function');
        });

        it('calls invoke with command "mls_join_group"', async () => {
            mockInvoke(JOINED_GROUP);
            await firstValueFrom(service.joinGroup(WELCOME, KEY_HANDLE));
            expect(callCmd()).toBe('mls_join_group');
        });

        it('passes welcomeB64 as "welcomeB64"', async () => {
            mockInvoke(JOINED_GROUP);
            await firstValueFrom(service.joinGroup(WELCOME, KEY_HANDLE));
            expect(callArgs()['welcomeB64']).toBe(WELCOME);
        });

        it('passes keyHandle as "keyHandle"', async () => {
            mockInvoke(JOINED_GROUP);
            await firstValueFrom(service.joinGroup(WELCOME, KEY_HANDLE));
            expect(callArgs()['keyHandle']).toBe(KEY_HANDLE);
        });

        it('passes exactly 2 keys to invoke (no raw key material)', async () => {
            mockInvoke(JOINED_GROUP);
            await firstValueFrom(service.joinGroup(WELCOME, KEY_HANDLE));
            expect(Object.keys(callArgs()).sort()).toEqual(['keyHandle', 'welcomeB64'].sort());
        });

        it('resolves with MlsGroupInfo from invoke', async () => {
            mockInvoke(JOINED_GROUP);
            const info = await firstValueFrom(service.joinGroup(WELCOME, KEY_HANDLE));
            expect(info).toEqual(JOINED_GROUP);
        });

        it('joiner leaf index is non-zero (creator holds 0)', async () => {
            mockInvoke(JOINED_GROUP);
            const info = await firstValueFrom(service.joinGroup(WELCOME, KEY_HANDLE));
            expect(info.ownLeafIndex).toBe(JOINED_GROUP.ownLeafIndex);
        });

        it('members list reflects the full group after joining', async () => {
            mockInvoke(JOINED_GROUP);
            const info = await firstValueFrom(service.joinGroup(WELCOME, KEY_HANDLE));
            expect(info.members.length).toBe(2);
        });

        it('propagates invoke rejection', async () => {
            mockInvokeReject('message is not a Welcome');
            await expect(
                firstValueFrom(service.joinGroup(WELCOME, KEY_HANDLE)),
            ).rejects.toBe('message is not a Welcome');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // leaveGroup
    // ─────────────────────────────────────────────────────────────────────────

    describe('leaveGroup', () => {
        const GID = 'Z3JvdXAxMjM=';
        const LEAVE_COMMIT: MlsCommitOut = {commit: 'bGVhdmU=', welcome: null, epoch: 5, groupInfo: null};

        it('returns an Observable', () => {
            mockInvoke(LEAVE_COMMIT);
            const result = service.leaveGroup(GID, KEY_HANDLE);
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe).toBe('function');
        });

        it('calls invoke with command "mls_leave_group"', async () => {
            mockInvoke(LEAVE_COMMIT);
            await firstValueFrom(service.leaveGroup(GID, KEY_HANDLE));
            expect(callCmd()).toBe('mls_leave_group');
        });

        it('passes groupIdB64 as "groupIdB64"', async () => {
            mockInvoke(LEAVE_COMMIT);
            await firstValueFrom(service.leaveGroup(GID, KEY_HANDLE));
            expect(callArgs()['groupIdB64']).toBe(GID);
        });

        it('passes keyHandle as "keyHandle"', async () => {
            mockInvoke(LEAVE_COMMIT);
            await firstValueFrom(service.leaveGroup(GID, KEY_HANDLE));
            expect(callArgs()['keyHandle']).toBe(KEY_HANDLE);
        });

        it('passes exactly 2 keys to invoke', async () => {
            mockInvoke(LEAVE_COMMIT);
            await firstValueFrom(service.leaveGroup(GID, KEY_HANDLE));
            expect(Object.keys(callArgs()).sort()).toEqual(['groupIdB64', 'keyHandle'].sort());
        });

        it('resolves with MlsCommitOut', async () => {
            mockInvoke(LEAVE_COMMIT);
            const result = await firstValueFrom(service.leaveGroup(GID, KEY_HANDLE));
            expect(result).toEqual(LEAVE_COMMIT);
        });

        it('welcome is null for a leave commit', async () => {
            mockInvoke(LEAVE_COMMIT);
            const result = await firstValueFrom(service.leaveGroup(GID, KEY_HANDLE));
            expect(result.welcome).toBeNull();
        });

        it('epoch is returned', async () => {
            mockInvoke(LEAVE_COMMIT);
            const result = await firstValueFrom(service.leaveGroup(GID, KEY_HANDLE));
            expect(result.epoch).toBe(5);
        });

        it('propagates invoke rejection', async () => {
            mockInvokeReject('group not found');
            await expect(firstValueFrom(service.leaveGroup(GID, KEY_HANDLE))).rejects.toBe('group not found');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // exportGroupInfo
    // ─────────────────────────────────────────────────────────────────────────

    describe('exportGroupInfo', () => {
        const GID = 'Z3JvdXAxMjM=';
        const GROUP_INFO_B64 = 'Z3JvdXBJbmZv';

        it('returns an Observable', () => {
            mockInvoke(GROUP_INFO_B64);
            const result = service.exportGroupInfo(GID, KEY_HANDLE);
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe).toBe('function');
        });

        it('calls invoke with command "mls_export_group_info"', async () => {
            mockInvoke(GROUP_INFO_B64);
            await firstValueFrom(service.exportGroupInfo(GID, KEY_HANDLE));
            expect(callCmd()).toBe('mls_export_group_info');
        });

        it('passes groupIdB64 as "groupIdB64"', async () => {
            mockInvoke(GROUP_INFO_B64);
            await firstValueFrom(service.exportGroupInfo(GID, KEY_HANDLE));
            expect(callArgs()['groupIdB64']).toBe(GID);
        });

        it('passes keyHandle as "keyHandle"', async () => {
            mockInvoke(GROUP_INFO_B64);
            await firstValueFrom(service.exportGroupInfo(GID, KEY_HANDLE));
            expect(callArgs()['keyHandle']).toBe(KEY_HANDLE);
        });

        it('passes exactly 2 keys to invoke', async () => {
            mockInvoke(GROUP_INFO_B64);
            await firstValueFrom(service.exportGroupInfo(GID, KEY_HANDLE));
            expect(Object.keys(callArgs()).sort()).toEqual(['groupIdB64', 'keyHandle'].sort());
        });

        it('resolves with the base64 GroupInfo string', async () => {
            mockInvoke(GROUP_INFO_B64);
            const result = await firstValueFrom(service.exportGroupInfo(GID, KEY_HANDLE));
            expect(result).toBe(GROUP_INFO_B64);
        });

        it('propagates invoke rejection', async () => {
            mockInvokeReject('group not found');
            await expect(firstValueFrom(service.exportGroupInfo(GID, KEY_HANDLE))).rejects.toBe('group not found');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // rejoinGroup
    // ─────────────────────────────────────────────────────────────────────────

    describe('rejoinGroup', () => {
        const GI_B64 = 'Z3JvdXBJbmZv';

        it('returns an Observable', () => {
            mockInvoke(REJOIN_OUT);
            const result = service.rejoinGroup(GI_B64, KEY_HANDLE);
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe).toBe('function');
        });

        it('calls invoke with command "mls_rejoin_group"', async () => {
            mockInvoke(REJOIN_OUT);
            await firstValueFrom(service.rejoinGroup(GI_B64, KEY_HANDLE));
            expect(callCmd()).toBe('mls_rejoin_group');
        });

        it('passes groupInfoB64 as "groupInfoB64"', async () => {
            mockInvoke(REJOIN_OUT);
            await firstValueFrom(service.rejoinGroup(GI_B64, KEY_HANDLE));
            expect(callArgs()['groupInfoB64']).toBe(GI_B64);
        });

        it('passes keyHandle as "keyHandle"', async () => {
            mockInvoke(REJOIN_OUT);
            await firstValueFrom(service.rejoinGroup(GI_B64, KEY_HANDLE));
            expect(callArgs()['keyHandle']).toBe(KEY_HANDLE);
        });

        it('passes exactly 2 keys to invoke', async () => {
            mockInvoke(REJOIN_OUT);
            await firstValueFrom(service.rejoinGroup(GI_B64, KEY_HANDLE));
            expect(Object.keys(callArgs()).sort()).toEqual(['groupInfoB64', 'keyHandle'].sort());
        });

        it('resolves with MlsRejoinOut', async () => {
            mockInvoke(REJOIN_OUT);
            const result = await firstValueFrom(service.rejoinGroup(GI_B64, KEY_HANDLE));
            expect(result).toEqual(REJOIN_OUT);
        });

        it('externalCommit is present', async () => {
            mockInvoke(REJOIN_OUT);
            const result = await firstValueFrom(service.rejoinGroup(GI_B64, KEY_HANDLE));
            expect(typeof result.externalCommit).toBe('string');
            expect(result.externalCommit.length).toBeGreaterThan(0);
        });

        it('groupInfo is present', async () => {
            mockInvoke(REJOIN_OUT);
            const result = await firstValueFrom(service.rejoinGroup(GI_B64, KEY_HANDLE));
            expect(result.groupInfo).toBeDefined();
        });

        it('propagates invoke rejection', async () => {
            mockInvokeReject('not a GroupInfo');
            await expect(firstValueFrom(service.rejoinGroup(GI_B64, KEY_HANDLE))).rejects.toBe('not a GroupInfo');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // deleteGroup
    // ─────────────────────────────────────────────────────────────────────────

    describe('deleteGroup', () => {
        const GID = 'Z3JvdXAxMjM=';

        it('returns an Observable', () => {
            mockInvoke(undefined);
            const result = service.deleteGroup(GID);
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe).toBe('function');
        });

        it('calls invoke with command "mls_delete_group"', async () => {
            mockInvoke(undefined);
            await firstValueFrom(service.deleteGroup(GID));
            expect(callCmd()).toBe('mls_delete_group');
        });

        it('passes groupIdB64 as "groupIdB64"', async () => {
            mockInvoke(undefined);
            await firstValueFrom(service.deleteGroup(GID));
            expect(callArgs()['groupIdB64']).toBe(GID);
        });

        it('passes exactly 1 key to invoke', async () => {
            mockInvoke(undefined);
            await firstValueFrom(service.deleteGroup(GID));
            expect(Object.keys(callArgs())).toEqual(['groupIdB64']);
        });

        it('propagates invoke rejection', async () => {
            mockInvokeReject('GroupNotFound: group not found');
            await expect(firstValueFrom(service.deleteGroup(GID))).rejects.toBe('GroupNotFound: group not found');
        });

        it('removes the group queue entry from _groupQueues on success', async () => {
            mockInvoke(undefined);
            const queues = (service as unknown as { _groupQueues: Map<string, Promise<unknown>> })
                ._groupQueues;
            queues.set(GID, Promise.resolve());
            await firstValueFrom(service.deleteGroup(GID));
            expect(queues.has(GID)).toBe(false);
        });

        it('does not clear the queue entry when invoke rejects', async () => {
            const queues = (service as unknown as { _groupQueues: Map<string, Promise<unknown>> })
                ._groupQueues;
            queues.set(GID, Promise.resolve());
            mockInvokeReject('GroupNotFound: group not found');
            await expect(firstValueFrom(service.deleteGroup(GID))).rejects.toBeTruthy();
            expect(queues.has(GID)).toBe(true);
        });

        it('queue deletion is safe when the group was never queued', async () => {
            mockInvoke(undefined);
            const queues = (service as unknown as { _groupQueues: Map<string, Promise<unknown>> })
                ._groupQueues;
            expect(queues.has(GID)).toBe(false);
            await firstValueFrom(service.deleteGroup(GID));
            expect(queues.has(GID)).toBe(false);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // sendMessage
    // ─────────────────────────────────────────────────────────────────────────

    describe('sendMessage', () => {
        const GID = 'Z3JvdXAxMjM=';
        const PT = 'aGVsbG8gd29ybGQ=';
        const CIPHERTEXT = 'Y2lwaGVydGV4dA==';

        it('returns an Observable', () => {
            mockInvoke(CIPHERTEXT);
            const result = service.sendMessage(GID, KEY_HANDLE, PT);
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe)
                .toBe('function');
        });

        it('calls invoke with command "mls_send_message"', async () => {
            mockInvoke(CIPHERTEXT);
            await firstValueFrom(service.sendMessage(GID, KEY_HANDLE, PT));
            expect(callCmd()).toBe('mls_send_message');
        });

        it('passes groupIdB64 as "groupIdB64"', async () => {
            mockInvoke(CIPHERTEXT);
            await firstValueFrom(service.sendMessage(GID, KEY_HANDLE, PT));
            expect(callArgs()['groupIdB64']).toBe(GID);
        });

        it('passes keyHandle as "keyHandle"', async () => {
            mockInvoke(CIPHERTEXT);
            await firstValueFrom(service.sendMessage(GID, KEY_HANDLE, PT));
            expect(callArgs()['keyHandle']).toBe(KEY_HANDLE);
        });

        it('passes plaintextB64 as "plaintextB64"', async () => {
            mockInvoke(CIPHERTEXT);
            await firstValueFrom(service.sendMessage(GID, KEY_HANDLE, PT));
            expect(callArgs()['plaintextB64']).toBe(PT);
        });

        it('passes exactly 3 keys to invoke (no raw key material)', async () => {
            mockInvoke(CIPHERTEXT);
            await firstValueFrom(service.sendMessage(GID, KEY_HANDLE, PT));
            expect(Object.keys(callArgs()).sort()).toEqual(
                ['groupIdB64', 'keyHandle', 'plaintextB64'].sort(),
            );
        });

        it('resolves with the ciphertext string from invoke', async () => {
            mockInvoke(CIPHERTEXT);
            const ct = await firstValueFrom(service.sendMessage(GID, KEY_HANDLE, PT));
            expect(ct).toBe(CIPHERTEXT);
        });

        it('passes empty plaintextB64 verbatim', async () => {
            mockInvoke(CIPHERTEXT);
            await firstValueFrom(service.sendMessage(GID, KEY_HANDLE, ''));
            expect(callArgs()['plaintextB64']).toBe('');
        });

        it('passes large plaintext base64 verbatim', async () => {
            const big = 'A'.repeat(10_000);
            mockInvoke(CIPHERTEXT);
            await firstValueFrom(service.sendMessage(GID, KEY_HANDLE, big));
            expect(callArgs()['plaintextB64']).toBe(big);
        });

        it('propagates invoke rejection', async () => {
            mockInvokeReject('group not found');
            await expect(
                firstValueFrom(service.sendMessage(GID, KEY_HANDLE, PT)),
            ).rejects.toBe('group not found');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // processMessage
    // ─────────────────────────────────────────────────────────────────────────

    describe('processMessage', () => {
        const GID = 'Z3JvdXAxMjM=';
        const MSG = 'bWxzTWVzc2FnZQ==';

        it('returns an Observable', () => {
            mockInvoke(APP_MESSAGE);
            const result = service.processMessage(GID, MSG);
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe)
                .toBe('function');
        });

        it('calls invoke with command "mls_process_message"', async () => {
            mockInvoke(APP_MESSAGE);
            await firstValueFrom(service.processMessage(GID, MSG));
            expect(callCmd()).toBe('mls_process_message');
        });

        it('passes groupIdB64 as "groupIdB64"', async () => {
            mockInvoke(APP_MESSAGE);
            await firstValueFrom(service.processMessage(GID, MSG));
            expect(callArgs()['groupIdB64']).toBe(GID);
        });

        it('passes messageB64 as "messageB64"', async () => {
            mockInvoke(APP_MESSAGE);
            await firstValueFrom(service.processMessage(GID, MSG));
            expect(callArgs()['messageB64']).toBe(MSG);
        });

        it('passes the group, the message and the message id', async () => {
            mockInvoke(APP_MESSAGE);
            await firstValueFrom(service.processMessage(GID, MSG, 'msg-1'));
            expect(Object.keys(callArgs()).sort())
                .toEqual(['groupIdB64', 'messageB64', 'messageId'].sort());
            // The id is what lets a buffered future-epoch message be attributed to the row it came
            // from when it is replayed; without it the plaintext surfaces with nothing to attach.
            expect(callArgs()['messageId']).toBe('msg-1');
        });

        // Application message discrimination
        describe('application message result', () => {
            it('resolves with kind "application"', async () => {
                mockInvoke(APP_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.kind).toBe('application');
            });

            it('plaintext is non-null and base64-encoded', async () => {
                mockInvoke(APP_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.plaintext).toBe(APP_MESSAGE.plaintext);
            });

            it('selfRemoved is false for an application message', async () => {
                mockInvoke(APP_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.selfRemoved).toBe(false);
            });

            it('addedMembers is empty for an application message', async () => {
                mockInvoke(APP_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.addedMembers).toEqual([]);
            });

            it('removedLeafIndices is empty for an application message', async () => {
                mockInvoke(APP_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.removedLeafIndices).toEqual([]);
            });

            it('epoch is null for an application message', async () => {
                mockInvoke(APP_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.epoch).toBeNull();
            });

            it('senderIdentity is returned', async () => {
                mockInvoke(APP_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.senderIdentity).toBe('alice');
            });
        });

        // Add-members commit discrimination
        describe('add-members commit result', () => {
            it('resolves with kind "commit"', async () => {
                mockInvoke(COMMIT_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.kind).toBe('commit');
            });

            it('plaintext is null for a commit', async () => {
                mockInvoke(COMMIT_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.plaintext).toBeNull();
            });

            it('addedMembers reflects new members', async () => {
                mockInvoke(COMMIT_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.addedMembers).toEqual([MEMBER_BOB]);
            });

            it('addedMembers has correct identity strings', async () => {
                mockInvoke(COMMIT_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.addedMembers[0].identity).toBe('bob');
            });

            it('removedLeafIndices is empty for an add commit', async () => {
                mockInvoke(COMMIT_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.removedLeafIndices).toEqual([]);
            });

            it('epoch is non-null and incremented after commit', async () => {
                mockInvoke(COMMIT_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.epoch).toBe(1);
            });

            it('selfRemoved is false for add-members commit', async () => {
                mockInvoke(COMMIT_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.selfRemoved).toBe(false);
            });
        });

        // Remove-members commit discrimination
        describe('remove-members commit result', () => {
            it('removedLeafIndices contains the removed leaf index', async () => {
                mockInvoke(REMOVAL_COMMIT_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.removedLeafIndices).toEqual([2]);
            });

            it('addedMembers is empty for a removal commit', async () => {
                mockInvoke(REMOVAL_COMMIT_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.addedMembers).toEqual([]);
            });

            it('epoch advances after removal commit', async () => {
                mockInvoke(REMOVAL_COMMIT_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.epoch).toBe(2);
            });
        });

        // Self-removal commit
        describe('self-removal commit result', () => {
            it('selfRemoved is true when we are the one removed', async () => {
                mockInvoke(SELF_REMOVAL_COMMIT);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.selfRemoved).toBe(true);
            });

            it('removedLeafIndices contains our leaf index', async () => {
                mockInvoke(SELF_REMOVAL_COMMIT);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.removedLeafIndices).toContain(0);
            });
        });

        // Proposal discrimination
        describe('proposal result', () => {
            it('resolves with kind "proposal"', async () => {
                mockInvoke(PROPOSAL_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.kind).toBe('proposal');
            });

            it('plaintext is null for a proposal', async () => {
                mockInvoke(PROPOSAL_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.plaintext).toBeNull();
            });

            it('selfRemoved is false for a proposal', async () => {
                mockInvoke(PROPOSAL_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.selfRemoved).toBe(false);
            });

            it('epoch is null for a proposal (no epoch advance)', async () => {
                mockInvoke(PROPOSAL_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.epoch).toBeNull();
            });

            it('senderIdentity is available for proposals', async () => {
                mockInvoke(PROPOSAL_MESSAGE);
                const msg = await firstValueFrom(service.processMessage(GID, MSG));
                expect(msg.senderIdentity).toBe('charlie');
            });
        });

        it('propagates invoke rejection', async () => {
            mockInvokeReject('bad message');
            await expect(
                firstValueFrom(service.processMessage(GID, MSG)),
            ).rejects.toBe('bad message');
        });

        describe('WrongEpoch error', () => {
            it('surfaces a WrongEpoch error from Rust', async () => {
                mockInvokeReject('WrongEpoch: epoch is 3 but message is for epoch 4');
                await expect(
                    firstValueFrom(service.processMessage(GID, MSG)),
                ).rejects.toBe('WrongEpoch: epoch is 3 but message is for epoch 4');
            });
        });
    });
    // The `verifySenderInRoster` and `processAndVerifyMessage` suites lived here. Both methods were
    // deleted: the guarantee they claimed was a tautology - openmls has already verified the sender
    // against an in-tree leaf before `process_message` returns - so these tests were asserting that
    // a check which cannot fail did not fail. The check that does something, the server-claimed
    // author against the authenticated credential, is covered in `mls-sync.service.spec.ts`.


    // ─────────────────────────────────────────────────────────────────────────
    // removeMembers
    // ─────────────────────────────────────────────────────────────────────────

    describe('removeMembers', () => {
        const GID = 'Z3JvdXAxMjM=';
        const LEAVES = [2, 4];

        it('returns an Observable', () => {
            mockInvoke(COMMIT_NO_WELCOME);
            const result = service.removeMembers(GID, KEY_HANDLE, LEAVES);
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe)
                .toBe('function');
        });

        it('calls invoke with command "mls_remove_members"', async () => {
            mockInvoke(COMMIT_NO_WELCOME);
            await firstValueFrom(service.removeMembers(GID, KEY_HANDLE, LEAVES));
            expect(callCmd()).toBe('mls_remove_members');
        });

        it('passes groupIdB64 as "groupIdB64"', async () => {
            mockInvoke(COMMIT_NO_WELCOME);
            await firstValueFrom(service.removeMembers(GID, KEY_HANDLE, LEAVES));
            expect(callArgs()['groupIdB64']).toBe(GID);
        });

        it('passes keyHandle as "keyHandle"', async () => {
            mockInvoke(COMMIT_NO_WELCOME);
            await firstValueFrom(service.removeMembers(GID, KEY_HANDLE, LEAVES));
            expect(callArgs()['keyHandle']).toBe(KEY_HANDLE);
        });

        it('passes leafIndices as "leafIndices"', async () => {
            mockInvoke(COMMIT_NO_WELCOME);
            await firstValueFrom(service.removeMembers(GID, KEY_HANDLE, LEAVES));
            expect(callArgs()['leafIndices']).toEqual(LEAVES);
        });

        it('passes exactly 3 keys to invoke (no raw key material)', async () => {
            mockInvoke(COMMIT_NO_WELCOME);
            await firstValueFrom(service.removeMembers(GID, KEY_HANDLE, LEAVES));
            expect(Object.keys(callArgs()).sort()).toEqual(
                ['groupIdB64', 'keyHandle', 'leafIndices'].sort(),
            );
        });

        it('resolves with MlsCommitOut from invoke', async () => {
            mockInvoke(COMMIT_NO_WELCOME);
            const result = await firstValueFrom(service.removeMembers(GID, KEY_HANDLE, LEAVES));
            expect(result).toEqual(COMMIT_NO_WELCOME);
        });

        it('welcome is null for a removal commit', async () => {
            mockInvoke(COMMIT_NO_WELCOME);
            const result = await firstValueFrom(service.removeMembers(GID, KEY_HANDLE, LEAVES));
            expect(result.welcome).toBeNull();
        });

        it('epoch is present after removal', async () => {
            mockInvoke(COMMIT_NO_WELCOME);
            const result = await firstValueFrom(service.removeMembers(GID, KEY_HANDLE, LEAVES));
            expect(typeof result.epoch).toBe('number');
        });

        it('handles single-element leafIndices array', async () => {
            mockInvoke(COMMIT_NO_WELCOME);
            await firstValueFrom(service.removeMembers(GID, KEY_HANDLE, [3]));
            expect(callArgs()['leafIndices']).toEqual([3]);
        });

        it('propagates invoke rejection', async () => {
            mockInvokeReject('group not found');
            await expect(
                firstValueFrom(service.removeMembers(GID, KEY_HANDLE, LEAVES)),
            ).rejects.toBe('group not found');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // getMembers
    // ─────────────────────────────────────────────────────────────────────────

    describe('getMembers', () => {
        const GID = 'Z3JvdXAxMjM=';
        const MEMBERS = [MEMBER_ALICE, MEMBER_BOB];

        it('returns an Observable', () => {
            mockInvoke(MEMBERS);
            const result = service.getMembers(GID);
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe)
                .toBe('function');
        });

        it('calls invoke with command "mls_get_members"', async () => {
            mockInvoke(MEMBERS);
            await firstValueFrom(service.getMembers(GID));
            expect(callCmd()).toBe('mls_get_members');
        });

        it('passes groupIdB64 as "groupIdB64"', async () => {
            mockInvoke(MEMBERS);
            await firstValueFrom(service.getMembers(GID));
            expect(callArgs()['groupIdB64']).toBe(GID);
        });

        it('passes exactly 1 key to invoke', async () => {
            mockInvoke(MEMBERS);
            await firstValueFrom(service.getMembers(GID));
            expect(Object.keys(callArgs())).toEqual(['groupIdB64']);
        });

        it('resolves with the member array from invoke', async () => {
            mockInvoke(MEMBERS);
            const result = await firstValueFrom(service.getMembers(GID));
            expect(result).toEqual(MEMBERS);
        });

        it('returns an array for a lone-member group', async () => {
            mockInvoke([MEMBER_ALICE]);
            const result = await firstValueFrom(service.getMembers(GID));
            expect(result.length).toBe(1);
        });

        it('each MlsMemberInfo has required fields', async () => {
            mockInvoke(MEMBERS);
            const result = await firstValueFrom(service.getMembers(GID));
            for (const m of result) {
                expect(typeof m.leafIndex).toBe('number');
                expect(typeof m.identity).toBe('string');
                expect(typeof m.encryptionKey).toBe('string');
                expect(typeof m.signatureKey).toBe('string');
            }
        });

        it('propagates invoke rejection', async () => {
            mockInvokeReject('group not found');
            await expect(
                firstValueFrom(service.getMembers(GID)),
            ).rejects.toBe('group not found');
        });

        it('resolves with an empty array when the group has no members', async () => {
            mockInvoke([]);
            const result = await firstValueFrom(service.getMembers(GID));
            expect(result).toEqual([]);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // getGroupInfo
    // ─────────────────────────────────────────────────────────────────────────

    describe('getGroupInfo', () => {
        const GID = 'Z3JvdXAxMjM=';

        it('returns an Observable', () => {
            mockInvoke(GROUP_INFO);
            const result = service.getGroupInfo(GID);
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe)
                .toBe('function');
        });

        it('calls invoke with command "mls_get_group_info"', async () => {
            mockInvoke(GROUP_INFO);
            await firstValueFrom(service.getGroupInfo(GID));
            expect(callCmd()).toBe('mls_get_group_info');
        });

        it('passes groupIdB64 as "groupIdB64"', async () => {
            mockInvoke(GROUP_INFO);
            await firstValueFrom(service.getGroupInfo(GID));
            expect(callArgs()['groupIdB64']).toBe(GID);
        });

        it('passes exactly 1 key to invoke', async () => {
            mockInvoke(GROUP_INFO);
            await firstValueFrom(service.getGroupInfo(GID));
            expect(Object.keys(callArgs())).toEqual(['groupIdB64']);
        });

        it('resolves with MlsGroupInfo from invoke', async () => {
            mockInvoke(GROUP_INFO);
            const info = await firstValueFrom(service.getGroupInfo(GID));
            expect(info).toEqual(GROUP_INFO);
        });

        it('groupId is present and is a string', async () => {
            mockInvoke(GROUP_INFO);
            const info = await firstValueFrom(service.getGroupInfo(GID));
            expect(typeof info.groupId).toBe('string');
        });

        it('epoch is a non-negative number', async () => {
            mockInvoke({...GROUP_INFO, epoch: 7});
            const info = await firstValueFrom(service.getGroupInfo(GID));
            expect(info.epoch).toBeGreaterThanOrEqual(0);
        });

        it('members array is present', async () => {
            mockInvoke(GROUP_INFO);
            const info = await firstValueFrom(service.getGroupInfo(GID));
            expect(Array.isArray(info.members)).toBe(true);
        });

        it('propagates invoke rejection', async () => {
            mockInvokeReject('group not found');
            await expect(
                firstValueFrom(service.getGroupInfo(GID)),
            ).rejects.toBe('group not found');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // IPC contract -all command names verified
    // ─────────────────────────────────────────────────────────────────────────

    describe('IPC contract: command names are snake_case', () => {
        const COMMANDS = [
            'generate_mls_key_packages',
            'mls_generate_key_packages_with_handle',
            'mls_load_signing_key',
            'mls_unload_signing_key',
            'mls_create_group',
            'mls_add_members',
            'mls_join_group',
            'mls_send_message',
            'mls_process_message',
            'mls_remove_members',
            'mls_leave_group',
            'mls_export_group_info',
            'mls_rejoin_group',
            'mls_delete_group',
            'mls_get_members',
            'mls_get_group_info',
            'mls_init_storage',
            'mls_export_state',
            'mls_import_state',
        ];

        it('all expected Rust command names are pure lowercase_underscore strings', () => {
            for (const cmd of COMMANDS) {
                expect(cmd).toMatch(/^[a-z][a-z0-9_]*$/);
            }
        });

        it('generateKeyPackages uses "generate_mls_key_packages"', async () => {
            mockInvoke(KEY_PKG_BATCH);
            await firstValueFrom(service.generateKeyPackages('alice', 1));
            expect(callCmd()).toBe('generate_mls_key_packages');
        });

        it('generateAdditionalKeyPackages uses "mls_generate_key_packages_with_handle"', async () => {
            mockInvoke([KEY_PKG_RESULT]);
            await firstValueFrom(service.generateAdditionalKeyPackages(KEY_HANDLE, 1));
            expect(callCmd()).toBe('mls_generate_key_packages_with_handle');
        });

        it('loadSigningKey uses "mls_load_signing_key"', async () => {
            mockInvoke(KEY_HANDLE);
            await firstValueFrom(service.loadSigningKey('p==', 'q==', 'alice'));
            expect(callCmd()).toBe('mls_load_signing_key');
        });

        it('unloadSigningKey uses "mls_unload_signing_key"', async () => {
            mockInvoke(undefined);
            await firstValueFrom(service.unloadSigningKey(KEY_HANDLE));
            expect(callCmd()).toBe('mls_unload_signing_key');
        });

        it('createGroup uses "mls_create_group"', async () => {
            mockInvoke(GROUP_INFO);
            await firstValueFrom(service.createGroup('a==', KEY_HANDLE));
            expect(callCmd()).toBe('mls_create_group');
        });

        it('addMembers uses "mls_add_members"', async () => {
            mockInvoke(COMMIT_WITH_WELCOME);
            await firstValueFrom(service.addMembers('a==', KEY_HANDLE, []));
            expect(callCmd()).toBe('mls_add_members');
        });

        it('joinGroup uses "mls_join_group"', async () => {
            mockInvoke(GROUP_INFO);
            await firstValueFrom(service.joinGroup('w==', KEY_HANDLE));
            expect(callCmd()).toBe('mls_join_group');
        });

        it('sendMessage uses "mls_send_message"', async () => {
            mockInvoke('ct==');
            await firstValueFrom(service.sendMessage('g==', KEY_HANDLE, 'pt=='));
            expect(callCmd()).toBe('mls_send_message');
        });

        it('processMessage uses "mls_process_message"', async () => {
            mockInvoke(APP_MESSAGE);
            await firstValueFrom(service.processMessage('g==', 'm=='));
            expect(callCmd()).toBe('mls_process_message');
        });

        it('removeMembers uses "mls_remove_members"', async () => {
            mockInvoke(COMMIT_NO_WELCOME);
            await firstValueFrom(service.removeMembers('g==', KEY_HANDLE, [1]));
            expect(callCmd()).toBe('mls_remove_members');
        });

        it('leaveGroup uses "mls_leave_group"', async () => {
            mockInvoke(COMMIT_NO_WELCOME);
            await firstValueFrom(service.leaveGroup('g==', KEY_HANDLE));
            expect(callCmd()).toBe('mls_leave_group');
        });

        it('exportGroupInfo uses "mls_export_group_info"', async () => {
            mockInvoke('gi==');
            await firstValueFrom(service.exportGroupInfo('g==', KEY_HANDLE));
            expect(callCmd()).toBe('mls_export_group_info');
        });

        it('rejoinGroup uses "mls_rejoin_group"', async () => {
            mockInvoke(REJOIN_OUT);
            await firstValueFrom(service.rejoinGroup('gi==', KEY_HANDLE));
            expect(callCmd()).toBe('mls_rejoin_group');
        });

        it('deleteGroup uses "mls_delete_group"', async () => {
            mockInvoke(undefined);
            await firstValueFrom(service.deleteGroup('g=='));
            expect(callCmd()).toBe('mls_delete_group');
        });

        it('getMembers uses "mls_get_members"', async () => {
            mockInvoke([]);
            await firstValueFrom(service.getMembers('g=='));
            expect(callCmd()).toBe('mls_get_members');
        });

        it('getGroupInfo uses "mls_get_group_info"', async () => {
            mockInvoke(GROUP_INFO);
            await firstValueFrom(service.getGroupInfo('g=='));
            expect(callCmd()).toBe('mls_get_group_info');
        });

        it('initStorage uses "mls_init_storage"', async () => {
            mockInvoke(true);
            await firstValueFrom(service.initStorage());
            expect(callCmd()).toBe('mls_init_storage');
        });

        it('exportState uses "mls_export_state"', async () => {
            mockInvoke('ZW5jcnlwdGVk');
            await firstValueFrom(service.exportState('a2V5'));
            expect(callCmd()).toBe('mls_export_state');
        });

        it('importState uses "mls_import_state"', async () => {
            mockInvoke(undefined);
            await firstValueFrom(service.importState('YmxvYg==', 'a2V5'));
            expect(callCmd()).toBe('mls_import_state');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // MlsCommitOut epoch field
    // ─────────────────────────────────────────────────────────────────────────

    describe('MlsCommitOut epoch field', () => {
        const GID = 'Z3JvdXAxMjM=';

        it('addMembers result includes epoch', async () => {
            mockInvoke({...COMMIT_WITH_WELCOME, epoch: 3});
            const result = await firstValueFrom(service.addMembers(GID, KEY_HANDLE, []));
            expect(result.epoch).toBe(3);
        });

        it('removeMembers result includes epoch', async () => {
            mockInvoke({...COMMIT_NO_WELCOME, epoch: 4});
            const result = await firstValueFrom(service.removeMembers(GID, KEY_HANDLE, [1]));
            expect(result.epoch).toBe(4);
        });

        it('leaveGroup result includes epoch', async () => {
            mockInvoke({commit: 'abc', welcome: null, epoch: 7});
            const result = await firstValueFrom(service.leaveGroup(GID, KEY_HANDLE));
            expect(result.epoch).toBe(7);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Observable semantics
    // ─────────────────────────────────────────────────────────────────────────

    describe('Observable semantics', () => {
        it('each method call triggers a fresh invoke', async () => {
            mockInvoke(KEY_PKG_BATCH);
            await firstValueFrom(service.generateKeyPackages('alice', 1));
            await firstValueFrom(service.generateKeyPackages('alice', 1));
            expect(invokeStub).toHaveBeenCalledTimes(2);
        });

        it('synchronously returns an Observable before invoke resolves', () => {
            mockInvoke(KEY_PKG_BATCH);
            const obs = service.generateKeyPackages('alice', 1);
            expect(obs).toBeDefined();
            expect(typeof (obs as unknown as { subscribe: unknown }).subscribe)
                .toBe('function');
        });

        it('different methods return independent Observables', async () => {
            mockInvoke(GROUP_INFO);
            const o1 = service.createGroup('a==', KEY_HANDLE);
            const o2 = service.getGroupInfo('a==');
            await firstValueFrom(o1);
            await firstValueFrom(o2);
            expect(invokeStub).toHaveBeenCalledTimes(2);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Per-group serialization queue
    // ─────────────────────────────────────────────────────────────────────────

    describe('per-group serialization queue', () => {
        const GID = 'Z3JvdXAxMjM=';

        it('sequential calls on the same group complete in order', async () => {
            const results: number[] = [];
            invokeStub
                .mockImplementationOnce(async () => {
                    results.push(1);
                    return GROUP_INFO;
                })
                .mockImplementationOnce(async () => {
                    results.push(2);
                    return GROUP_INFO;
                });

            const a = firstValueFrom(service.createGroup(GID, KEY_HANDLE));
            const b = firstValueFrom(service.createGroup(GID, KEY_HANDLE));
            await Promise.all([a, b]);
            expect(results).toEqual([1, 2]);
        });

        it('different groups use independent queues', async () => {
            mockInvoke(GROUP_INFO);
            const a = firstValueFrom(service.createGroup('Z3JvdXAxMjM=', KEY_HANDLE));
            const b = firstValueFrom(service.createGroup('Z3JvdXAyMjM=', KEY_HANDLE));
            await Promise.all([a, b]);
            expect(invokeStub).toHaveBeenCalledTimes(2);
        });

        it('queue continues after a prior operation fails', async () => {
            const results: number[] = [];
            invokeStub
                .mockRejectedValueOnce('network error')
                .mockImplementationOnce(async () => {
                    results.push(2);
                    return GROUP_INFO;
                });

            const a = firstValueFrom(service.createGroup(GID, KEY_HANDLE)).catch(() => {
            });
            const b = firstValueFrom(service.createGroup(GID, KEY_HANDLE));
            await b;
            expect(results).toEqual([2]);
        });

        it('sendMessage serializes operations on the same group', async () => {
            const results: number[] = [];
            invokeStub
                .mockImplementationOnce(async () => {
                    results.push(1);
                    return 'Y3Qx';
                })
                .mockImplementationOnce(async () => {
                    results.push(2);
                    return 'Y3Qy';
                });

            const a = firstValueFrom(service.sendMessage(GID, KEY_HANDLE, 'cHQx'));
            const b = firstValueFrom(service.sendMessage(GID, KEY_HANDLE, 'cHQy'));
            await Promise.all([a, b]);
            expect(results).toEqual([1, 2]);
        });

        it('processMessage serializes operations on the same group', async () => {
            const results: number[] = [];
            invokeStub
                .mockImplementationOnce(async () => {
                    results.push(1);
                    return APP_MESSAGE;
                })
                .mockImplementationOnce(async () => {
                    results.push(2);
                    return APP_MESSAGE;
                });

            const a = firstValueFrom(service.processMessage(GID, 'bXNnMQ=='));
            const b = firstValueFrom(service.processMessage(GID, 'bXNnMg=='));
            await Promise.all([a, b]);
            expect(results).toEqual([1, 2]);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // initStorage
    // ─────────────────────────────────────────────────────────────────────────

    describe('initStorage', () => {
        it('returns an Observable', () => {
            mockInvoke(false);
            const result = service.initStorage();
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe).toBe('function');
        });

        it('calls invoke with command "mls_init_storage"', async () => {
            mockInvoke(false);
            await firstValueFrom(service.initStorage());
            expect(callCmd()).toBe('mls_init_storage');
        });

        it('passes the state key so the file is never written in the clear', async () => {
            mockInvoke(true);
            await firstValueFrom(service.initStorage());
            // Fetched inside the service rather than taken as a parameter, so no caller can forget
            // it and quietly leave every private key on disk as plain JSON.
            expect(Object.keys(callArgs())).toEqual(['stateKeyB64']);
            expect(callArgs()['stateKeyB64']).toBeTruthy();
        });

        it('resolves with true when state was restored from disk', async () => {
            mockInvoke(true);
            const restored = await firstValueFrom(service.initStorage());
            expect(restored).toBe(true);
        });

        it('resolves with false when starting fresh (no prior state)', async () => {
            mockInvoke(false);
            const restored = await firstValueFrom(service.initStorage());
            expect(restored).toBe(false);
        });

        it('propagates invoke rejection', async () => {
            mockInvokeReject('failed to create app data dir');
            await expect(firstValueFrom(service.initStorage())).rejects.toBe('failed to create app data dir');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // exportState
    // ─────────────────────────────────────────────────────────────────────────

    describe('exportState', () => {
        const ENC_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // 32-byte key b64
        const BLOB = 'bm9uY2VjaXBoZXJ0ZXh0'; // fake encrypted blob

        it('returns an Observable', () => {
            mockInvoke(BLOB);
            const result = service.exportState(ENC_KEY);
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe).toBe('function');
        });

        it('calls invoke with command "mls_export_state"', async () => {
            mockInvoke(BLOB);
            await firstValueFrom(service.exportState(ENC_KEY));
            expect(callCmd()).toBe('mls_export_state');
        });

        it('passes encryptionKeyB64 as "encryptionKeyB64"', async () => {
            mockInvoke(BLOB);
            await firstValueFrom(service.exportState(ENC_KEY));
            expect(callArgs()['encryptionKeyB64']).toBe(ENC_KEY);
        });

        it('passes exactly 1 key to invoke', async () => {
            mockInvoke(BLOB);
            await firstValueFrom(service.exportState(ENC_KEY));
            expect(Object.keys(callArgs())).toEqual(['encryptionKeyB64']);
        });

        it('resolves with the encrypted blob string', async () => {
            mockInvoke(BLOB);
            const result = await firstValueFrom(service.exportState(ENC_KEY));
            expect(result).toBe(BLOB);
        });

        it('propagates invoke rejection', async () => {
            mockInvokeReject('MlsError: encryption failed');
            await expect(firstValueFrom(service.exportState(ENC_KEY))).rejects.toBe('MlsError: encryption failed');
        });

        it('each call triggers a fresh invoke', async () => {
            mockInvoke(BLOB);
            await firstValueFrom(service.exportState(ENC_KEY));
            await firstValueFrom(service.exportState(ENC_KEY));
            expect(invokeStub).toHaveBeenCalledTimes(2);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // importState
    // ─────────────────────────────────────────────────────────────────────────

    describe('importState', () => {
        const ENC_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
        const BLOB = 'bm9uY2VjaXBoZXJ0ZXh0';

        it('returns an Observable', () => {
            mockInvoke(undefined);
            const result = service.importState(BLOB, ENC_KEY);
            expect(typeof (result as unknown as { subscribe: unknown }).subscribe).toBe('function');
        });

        it('calls invoke with command "mls_import_state"', async () => {
            mockInvoke(undefined);
            await firstValueFrom(service.importState(BLOB, ENC_KEY));
            expect(callCmd()).toBe('mls_import_state');
        });

        it('passes encryptedB64 as "encryptedB64"', async () => {
            mockInvoke(undefined);
            await firstValueFrom(service.importState(BLOB, ENC_KEY));
            expect(callArgs()['encryptedB64']).toBe(BLOB);
        });

        it('passes encryptionKeyB64 as "encryptionKeyB64"', async () => {
            mockInvoke(undefined);
            await firstValueFrom(service.importState(BLOB, ENC_KEY));
            expect(callArgs()['encryptionKeyB64']).toBe(ENC_KEY);
        });

        it('passes exactly 2 keys to invoke', async () => {
            mockInvoke(undefined);
            await firstValueFrom(service.importState(BLOB, ENC_KEY));
            expect(Object.keys(callArgs()).sort()).toEqual(['encryptedB64', 'encryptionKeyB64'].sort());
        });

        it('resolves with void on success', async () => {
            mockInvoke(undefined);
            const result = await firstValueFrom(service.importState(BLOB, ENC_KEY));
            expect(result).toBeUndefined();
        });

        it('propagates invoke rejection (wrong key)', async () => {
            mockInvokeReject('MlsError: aead::Error');
            await expect(firstValueFrom(service.importState(BLOB, ENC_KEY))).rejects.toBe('MlsError: aead::Error');
        });

        it('propagates invoke rejection (truncated blob)', async () => {
            mockInvokeReject('MlsError: encrypted blob too short');
            await expect(firstValueFrom(service.importState('dG9vc2hvcnQ=', ENC_KEY))).rejects.toBe('MlsError: encrypted blob too short');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Full group lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    describe('full MLS group lifecycle', () => {
        const ALICE_ID = 'alice@example.com';
        const BOB_ID = 'bob@example.com';
        const GID = 'Z3JvdXAxMjM=';
        const ALICE_HANDLE = 'alice-handle-uuid';
        const BOB_HANDLE = 'bob-handle-uuid';

        const ALICE_BATCH: MlsKeyPackageBatch = {
            signingPublicKey: 'YWxpY2VwdWI=',
            signingPrivateKey: 'YWxpY2Vwcml2',
            keyPackages: [{keyPackage: 'YWxpY2Vrcw==', initPrivateKey: 'YWxpY2Vpbml0'}],
            keyHandle: ALICE_HANDLE,
        };

        const BOB_BATCH: MlsKeyPackageBatch = {
            signingPublicKey: 'Ym9icHVi',
            signingPrivateKey: 'Ym9icHJpdg==',
            keyPackages: [{keyPackage: 'Ym9ia3A=', initPrivateKey: 'Ym9paW5pdA=='}],
            keyHandle: BOB_HANDLE,
        };

        const ALICE_EXTRA_PKGS: KeyPackageResult[] = [
            {keyPackage: 'ZXh0cmExMA==', initPrivateKey: 'ZXh0cmFpbml0'},
        ];

        const CREATED_GROUP: MlsGroupInfo = {
            groupId: GID,
            epoch: 0,
            ownLeafIndex: 0,
            members: [MEMBER_ALICE],
        };

        const ADD_COMMIT: MlsCommitOut = {
            commit: 'YWRkQ29tbWl0',
            welcome: 'd2VsY29tZQ==',
            epoch: 1,
            groupInfo: null,
        };

        const JOINED_GROUP: MlsGroupInfo = {
            groupId: GID,
            epoch: 1,
            ownLeafIndex: 2,
            members: [MEMBER_ALICE, MEMBER_BOB],
        };

        const PLAINTEXT_B64 = 'aGVsbG8gYm9i';
        const CIPHERTEXT = 'Y2lwaGVydGV4dA==';

        const APP_MSG_FROM_ALICE: MlsProcessedMessage = {
            kind: 'application',
            plaintext: PLAINTEXT_B64,
            selfRemoved: false,
            addedMembers: [],
            removedLeafIndices: [],
            senderIdentity: 'alice',
            epoch: null,
        };

        const ADD_COMMIT_PROCESSED: MlsProcessedMessage = {
            kind: 'commit',
            plaintext: null,
            selfRemoved: false,
            addedMembers: [MEMBER_BOB],
            removedLeafIndices: [],
            senderIdentity: 'alice',
            epoch: 1,
        };

        const REMOVE_COMMIT: MlsCommitOut = {
            commit: 'cmVtb3ZlQ29tbWl0',
            welcome: null,
            epoch: 2,
            groupInfo: null,
        };

        const LEAVE_COMMIT: MlsCommitOut = {
            commit: 'bGVhdmVDb21taXQ=',
            welcome: null,
            epoch: 3,
            groupInfo: null,
        };

        it('generate → replenish → create → add → join → send → receive → remove → leave → delete', async () => {
            // Step 1: Alice generates her initial key packages (new keypair + handle)
            invokeStub.mockResolvedValueOnce(ALICE_BATCH as never);
            const aliceBatch = await firstValueFrom(service.generateKeyPackages(ALICE_ID, 1));
            expect(callCmd(0)).toBe('generate_mls_key_packages');
            expect(callArgs(0)['identity']).toBe(ALICE_ID);
            expect(aliceBatch.keyHandle).toBe(ALICE_HANDLE);

            // Step 2: Alice replenishes key packages without rotating her signing key
            invokeStub.mockResolvedValueOnce(ALICE_EXTRA_PKGS as never);
            const extraPkgs = await firstValueFrom(
                service.generateAdditionalKeyPackages(ALICE_HANDLE, 1),
            );
            expect(callCmd(1)).toBe('mls_generate_key_packages_with_handle');
            expect(callArgs(1)['keyHandle']).toBe(ALICE_HANDLE);
            expect(callArgs(1)['count']).toBe(1);
            expect(extraPkgs).toEqual(ALICE_EXTRA_PKGS);

            // Step 3: Bob generates his key packages independently
            invokeStub.mockResolvedValueOnce(BOB_BATCH as never);
            const bobBatch = await firstValueFrom(service.generateKeyPackages(BOB_ID, 1));
            expect(callCmd(2)).toBe('generate_mls_key_packages');
            expect(bobBatch.keyHandle).toBe(BOB_HANDLE);

            // Step 4: Alice creates the group (epoch 0, only member)
            invokeStub.mockResolvedValueOnce(CREATED_GROUP as never);
            const createdGroup = await firstValueFrom(service.createGroup(GID, ALICE_HANDLE));
            expect(callCmd(3)).toBe('mls_create_group');
            expect(createdGroup.epoch).toBe(0);
            expect(createdGroup.ownLeafIndex).toBe(0);
            expect(createdGroup.members.length).toBe(1);

            // Step 5: Alice adds Bob -produces a commit and a welcome
            invokeStub.mockResolvedValueOnce(ADD_COMMIT as never);
            const addOut = await firstValueFrom(
                service.addMembers(GID, ALICE_HANDLE, [bobBatch.keyPackages[0].keyPackage]),
            );
            expect(callCmd(4)).toBe('mls_add_members');
            expect(callArgs(4)['keyPackagesB64']).toEqual([BOB_BATCH.keyPackages[0].keyPackage]);
            expect(addOut.welcome).not.toBeNull();
            expect(addOut.epoch).toBe(1);

            // Step 6: Bob joins via the welcome -sees both members in the roster
            invokeStub.mockResolvedValueOnce(JOINED_GROUP as never);
            const joinedGroup = await firstValueFrom(service.joinGroup(addOut.welcome!, BOB_HANDLE));
            expect(callCmd(5)).toBe('mls_join_group');
            expect(callArgs(5)['welcomeB64']).toBe(ADD_COMMIT.welcome);
            expect(joinedGroup.members.length).toBe(2);
            expect(joinedGroup.ownLeafIndex).toBe(2);

            // Step 7: Alice encrypts a message to the group
            invokeStub.mockResolvedValueOnce(CIPHERTEXT as never);
            const ct = await firstValueFrom(service.sendMessage(GID, ALICE_HANDLE, PLAINTEXT_B64));
            expect(callCmd(6)).toBe('mls_send_message');
            expect(callArgs(6)['plaintextB64']).toBe(PLAINTEXT_B64);
            expect(ct).toBe(CIPHERTEXT);

            // Step 8: Bob receives the message. No roster re-check - openmls resolved the sender
            // from an in-tree leaf and verified the signature before returning, so the credential
            // is already proved to belong to a current member.
            invokeStub.mockResolvedValueOnce(APP_MSG_FROM_ALICE as never);
            const received = await firstValueFrom(service.processMessage(GID, CIPHERTEXT));
            expect(callCmd(7)).toBe('mls_process_message');
            expect(received.kind).toBe('application');
            expect(received.plaintext).toBe(PLAINTEXT_B64);
            expect(received.senderIdentity).toBe('alice');

            // Step 9: Alice processes the add-commit she received from the server broadcast
            invokeStub.mockResolvedValueOnce(ADD_COMMIT_PROCESSED as never);
            const commitResult = await firstValueFrom(service.processMessage(GID, addOut.commit));
            expect(callCmd(8)).toBe('mls_process_message');
            expect(commitResult.kind).toBe('commit');
            expect(commitResult.addedMembers[0].identity).toBe('bob');
            expect(commitResult.epoch).toBe(1);

            // Step 10: Alice removes Bob from the group
            invokeStub.mockResolvedValueOnce(REMOVE_COMMIT as never);
            const removeOut = await firstValueFrom(
                service.removeMembers(GID, ALICE_HANDLE, [MEMBER_BOB.leafIndex]),
            );
            expect(callCmd(9)).toBe('mls_remove_members');
            expect(callArgs(9)['leafIndices']).toEqual([MEMBER_BOB.leafIndex]);
            expect(removeOut.welcome).toBeNull();
            expect(removeOut.epoch).toBe(2);

            // Step 11: Alice leaves the group (self-removal commit)
            invokeStub.mockResolvedValueOnce(LEAVE_COMMIT as never);
            const leaveOut = await firstValueFrom(service.leaveGroup(GID, ALICE_HANDLE));
            expect(callCmd(10)).toBe('mls_leave_group');
            expect(leaveOut.welcome).toBeNull();
            expect(leaveOut.epoch).toBe(3);

            // Step 12: Alice deletes the local group state -queue entry is cleaned up
            invokeStub.mockResolvedValueOnce(undefined as never);
            const queues = (service as unknown as { _groupQueues: Map<string, Promise<unknown>> })
                ._groupQueues;
            await firstValueFrom(service.deleteGroup(GID));
            expect(callCmd(11)).toBe('mls_delete_group');
            expect(queues.has(GID)).toBe(false);

            // Verify every lifecycle step produced exactly one invoke call
            expect(invokeStub).toHaveBeenCalledTimes(12);
        });
    });
    // ─────────────────────────────────────────────────────────────────────────
    // Message cache at rest
    //
    // It holds the plaintext of every message this device has ever read, which made it a larger
    // at-rest exposure than the ciphertext sitting on the server, and it grew without limit for
    // the life of the installation.
    // ─────────────────────────────────────────────────────────────────────────

    describe('message cache', () => {
        it('round-trips a cached plaintext', async () => {
            await service.cacheMessage('msg-1', 'aGVsbG8=');
            expect(await service.getCachedMessage('msg-1')).toBe('aGVsbG8=');
        });

        it('does not store the plaintext where a disk reader can find it', async () => {
            await service.cacheMessage('msg-1', 'aGVsbG8=');

            const raw = (service as unknown as { _messageCache: { get(k: string): Promise<unknown> } })
                ._messageCache;
            const stored = await raw.get('msg-1') as { iv: string; ct: string };

            expect(stored.iv).toBeTruthy();
            expect(stored.ct).toBeTruthy();
            expect(JSON.stringify(stored)).not.toContain('aGVsbG8=');
        });

        it('reads an entry written before the cache was sealed', async () => {
            const raw = (service as unknown as {
                _messageCache: { set(k: string, v: unknown): Promise<void> }
            })._messageCache;
            // Bare base64 is what shipped. Discarding those entries would throw away the only copy
            // of that message's plaintext - MLS decrypts from the wire exactly once.
            await raw.set('legacy', 'bGVnYWN5');

            expect(await service.getCachedMessage('legacy')).toBe('bGVnYWN5');
        });

        it('returns null rather than garbage for an entry it cannot open', async () => {
            const raw = (service as unknown as {
                _messageCache: { set(k: string, v: unknown): Promise<void> }
            })._messageCache;
            await raw.set('broken', {v: 1, at: Date.now(), iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA'});

            // No worse than a cache miss: the message renders as undecryptable.
            expect(await service.getCachedMessage('broken')).toBeNull();
        });

        it('clears every entry on a wipe', async () => {
            await service.cacheMessage('msg-1', 'aGVsbG8=');
            await service.clearMessageCache();
            expect(await service.getCachedMessage('msg-1')).toBeNull();
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Fail-closed outside Tauri
    // ─────────────────────────────────────────────────────────────────────────

    describe('outside Tauri', () => {
        const GID = 'Z3JvdXAxMjM=';

        it('refuses every engine call rather than reporting success', async () => {
            vi.mocked(isTauri).mockReturnValue(false);
            try {
                // The app happens not to boot in a browser today, so nothing here was ever reached
                // from one - but 'it crashes earlier' is not an access control, and a build that
                // got this far would report success for operations that never happened.
                // Thrown where the call is made, not surfaced later as a rejected stream: a
                // caller that never subscribes must not be able to believe the work was queued.
                expect(() => service.getMembers(GID)).toThrow(/MLS is unavailable/);
                await expect(firstValueFrom(service.processMessage(GID, 'bXNn')))
                    .rejects.toThrow(/MLS is unavailable/);
                expect(invokeStub).not.toHaveBeenCalled();
            } finally {
                vi.mocked(isTauri).mockReturnValue(true);
            }
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Commands this build may not define
//
// `mls_drain_pending_messages`, `mls_export_backup` and `mls_import_backup` currently have a
// TypeScript caller and no Rust definition - the engine file was overwritten with the other
// client's and the restore brought back a surface that predates them. They return with the re-port.
// Until then an unresolved command must degrade, not throw: unit tests mock the IPC boundary, so
// nothing else catches this.
// ─────────────────────────────────────────────────────────────────────────────

describe('MlsService when a command is missing from the build', () => {
    let service: MlsService;

    const notFound = (command: string) =>
        Promise.reject(`Command ${command} not found`);

    beforeEach(() => {
        invokeStub.mockReset();
        vi.mocked(isTauri).mockReturnValue(true);
        TestBed.configureTestingModule({providers: [MlsService]});
        service = TestBed.inject(MlsService);
    });

    it('treats an absent drain command as an empty buffer', async () => {
        invokeStub.mockImplementation(() => notFound('mls_drain_pending_messages') as never);

        // Empty is the honest answer: no buffer exists, so nothing was held. Catch-up runs this on
        // every sync, and throwing would log an error per context per launch forever.
        await expect(firstValueFrom(service.drainPendingMessages('Z3JvdXA=')))
            .resolves.toEqual([]);
    });

    it('reports an absent export as unavailable rather than failed', async () => {
        invokeStub.mockImplementation(() => notFound('mls_export_backup') as never);
        service.keyHandle.set('handle');

        // The distinction the logout dialog needs: "not available" offers a way forward, "failed"
        // sends the user back to retry something that can never succeed.
        await expect(service.exportBackup('pw', 'user-1', '3.0.0', false))
            .rejects.toBeInstanceOf(MlsFeatureUnavailableError);
    });

    it('reports an absent import as unavailable rather than failed', async () => {
        invokeStub.mockImplementation(() => notFound('mls_import_backup') as never);

        await expect(service.importBackup('blob', 'pw', 'user-1'))
            .rejects.toBeInstanceOf(MlsFeatureUnavailableError);
    });

    it('does not mistake a real engine failure for a missing command', async () => {
        // The guard matches the command name *and* not-found wording. An engine error that happens
        // to contain "not found" - a missing group, a missing key - must still propagate, or a
        // genuine fault would be silently swallowed as an absent feature.
        invokeStub.mockImplementation(() =>
            Promise.reject('GroupNotFound: group not found') as never);

        await expect(firstValueFrom(service.drainPendingMessages('Z3JvdXA=')))
            .rejects.toBe('GroupNotFound: group not found');
    });

    it('still surfaces an export failure from a command that does exist', async () => {
        invokeStub.mockImplementation(() => Promise.reject('MlsError: disk full') as never);
        service.keyHandle.set('handle');

        await expect(service.exportBackup('pw', 'user-1', '3.0.0', false))
            .rejects.not.toBeInstanceOf(MlsFeatureUnavailableError);
    });
});
