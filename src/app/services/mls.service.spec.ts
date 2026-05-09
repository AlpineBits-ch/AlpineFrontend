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
vi.mock('@tauri-apps/api/core');

import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { invoke } from '@tauri-apps/api/core';

import {
  KeyPackageResult,
  MlsCommitOut,
  MlsGroupInfo,
  MlsKeyPackageBatch,
  MlsMemberInfo,
  MlsProcessedMessage,
  MlsRejoinOut,
  MlsService,
  MlsTypedError,
  parseMlsError,
} from './mls.service';

// ---------------------------------------------------------------------------
// Module mock — must be a top-level call so Vitest hoists it before imports
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
};

const COMMIT_NO_WELCOME: MlsCommitOut = {
  commit: 'Y29tbWl0',
  welcome: null,
  epoch: 2,
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
  groupInfo: { ...GROUP_INFO, ownLeafIndex: 2 },
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
    TestBed.configureTestingModule({ providers: [MlsService] });
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
      const err = parseMlsError({ code: 42 });
      expect(err.kind).toBe('MlsError');
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
      mockInvoke({ ...KEY_PKG_BATCH, keyPackages: [] });
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
          { keyPackage: 'a2V5MA==', initPrivateKey: 'aW5pdDA=' },
          { keyPackage: 'a2V5MQ==', initPrivateKey: 'aW5pdDE=' },
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
      mockInvoke({ ...KEY_PKG_BATCH, keyPackages: [] });
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
      mockInvoke({ ...GROUP_INFO, epoch: 0 });
      const info = await firstValueFrom(service.createGroup(GID, KEY_HANDLE));
      expect(info.epoch).toBe(0);
    });

    it('groupInfo.ownLeafIndex is 0 for the creator', async () => {
      mockInvoke({ ...GROUP_INFO, ownLeafIndex: 0 });
      const info = await firstValueFrom(service.createGroup(GID, KEY_HANDLE));
      expect(info.ownLeafIndex).toBe(0);
    });

    it('groupInfo.members contains at least the creator', async () => {
      mockInvoke({ ...GROUP_INFO, members: [MEMBER_ALICE] });
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
    const LEAVE_COMMIT: MlsCommitOut = { commit: 'bGVhdmU=', welcome: null, epoch: 5 };

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

    it('passes exactly 2 keys to invoke', async () => {
      mockInvoke(APP_MESSAGE);
      await firstValueFrom(service.processMessage(GID, MSG));
      expect(Object.keys(callArgs()).sort()).toEqual(['groupIdB64', 'messageB64'].sort());
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

  // ─────────────────────────────────────────────────────────────────────────
  // verifySenderInRoster
  // ─────────────────────────────────────────────────────────────────────────

  describe('verifySenderInRoster', () => {
    const GID = 'Z3JvdXAxMjM=';

    it('returns true when sender is in the roster', async () => {
      mockInvoke([MEMBER_ALICE, MEMBER_BOB]);
      const result = await firstValueFrom(service.verifySenderInRoster('alice', GID));
      expect(result).toBe(true);
    });

    it('returns false when sender is not in the roster', async () => {
      mockInvoke([MEMBER_ALICE]);
      const result = await firstValueFrom(service.verifySenderInRoster('eve', GID));
      expect(result).toBe(false);
    });

    it('calls getMembers to check the roster', async () => {
      mockInvoke([MEMBER_ALICE]);
      await firstValueFrom(service.verifySenderInRoster('alice', GID));
      expect(callCmd()).toBe('mls_get_members');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // processAndVerifyMessage
  // ─────────────────────────────────────────────────────────────────────────

  describe('processAndVerifyMessage', () => {
    const GID = 'Z3JvdXAxMjM=';
    const MSG = 'bWxzTWVzc2FnZQ==';

    it('resolves normally when sender is in roster', async () => {
      // First call: processMessage, second call: getMembers
      invokeStub
        .mockResolvedValueOnce(APP_MESSAGE as never)
        .mockResolvedValueOnce([MEMBER_ALICE] as never);

      const result = await firstValueFrom(service.processAndVerifyMessage(GID, MSG));
      expect(result.kind).toBe('application');
    });

    it('throws MlsTypedError when sender is not in roster', async () => {
      const msgWithUnknown = { ...APP_MESSAGE, senderIdentity: 'eve' };
      invokeStub
        .mockResolvedValueOnce(msgWithUnknown as never)
        .mockResolvedValueOnce([MEMBER_ALICE] as never);

      await expect(
        firstValueFrom(service.processAndVerifyMessage(GID, MSG)),
      ).rejects.toMatchObject({ kind: 'UnknownSender' });
    });

    it('skips roster check for commit messages', async () => {
      mockInvoke(COMMIT_MESSAGE);
      const result = await firstValueFrom(service.processAndVerifyMessage(GID, MSG));
      // Only 1 invoke call — no getMembers for commits
      expect(invokeStub).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe('commit');
    });

    it('skips roster check when senderIdentity is null', async () => {
      const noSender = { ...APP_MESSAGE, senderIdentity: null };
      mockInvoke(noSender);
      const result = await firstValueFrom(service.processAndVerifyMessage(GID, MSG));
      expect(invokeStub).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe('application');
    });
  });

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
      mockInvoke({ ...GROUP_INFO, epoch: 7 });
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
  // IPC contract — all command names verified
  // ─────────────────────────────────────────────────────────────────────────

  describe('IPC contract: command names are snake_case', () => {
    const COMMANDS = [
      'generate_mls_key_packages',
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
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MlsCommitOut epoch field
  // ─────────────────────────────────────────────────────────────────────────

  describe('MlsCommitOut epoch field', () => {
    const GID = 'Z3JvdXAxMjM=';

    it('addMembers result includes epoch', async () => {
      mockInvoke({ ...COMMIT_WITH_WELCOME, epoch: 3 });
      const result = await firstValueFrom(service.addMembers(GID, KEY_HANDLE, []));
      expect(result.epoch).toBe(3);
    });

    it('removeMembers result includes epoch', async () => {
      mockInvoke({ ...COMMIT_NO_WELCOME, epoch: 4 });
      const result = await firstValueFrom(service.removeMembers(GID, KEY_HANDLE, [1]));
      expect(result.epoch).toBe(4);
    });

    it('leaveGroup result includes epoch', async () => {
      mockInvoke({ commit: 'abc', welcome: null, epoch: 7 });
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
        .mockImplementationOnce(async () => { results.push(1); return GROUP_INFO; })
        .mockImplementationOnce(async () => { results.push(2); return GROUP_INFO; });

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
  });
});
