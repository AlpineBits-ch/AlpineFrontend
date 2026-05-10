import {Injectable, signal} from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { from, Observable, of } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { LazyStore } from '@tauri-apps/plugin-store';
import { secureStorage } from 'tauri-plugin-secure-storage-api';

// ---------------------------------------------------------------------------
// Typed error system
// ---------------------------------------------------------------------------

export type MlsErrorKind =
  | 'WrongEpoch'
  | 'UnknownSender'
  | 'ValidationError'
  | 'GroupNotFound'
  | 'KeyNotFound'
  | 'MlsError';

export interface MlsTypedError {
  kind: MlsErrorKind;
  message: string;
}

const ERROR_KINDS: MlsErrorKind[] = [
  'WrongEpoch', 'UnknownSender', 'ValidationError', 'GroupNotFound', 'KeyNotFound',
];

export function parseMlsError(raw: unknown): MlsTypedError {
  const msg = typeof raw === 'string' ? raw : String(raw);
  for (const kind of ERROR_KINDS) {
    if (msg.startsWith(kind + ': ') || msg.startsWith(kind + ':')) {
      return { kind, message: msg.slice(kind.length + 1).trimStart() };
    }
  }
  return { kind: 'MlsError', message: msg };
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface KeyPackageResult {
  /** TLS-serialized KeyPackage (base64) — upload to server */
  keyPackage: string;
  /** HPKE init private key (base64) — store encrypted under the master key */
  initPrivateKey: string;
}

export interface MlsKeyPackageBatch {
  /** Ed25519 public key (base64) */
  signingPublicKey: string;
  /**
   * Ed25519 private key (base64) — store encrypted under the master key.
   * On each session unlock pass this to `loadSigningKey` to get a `keyHandle`,
   * then discard from JS memory. Never pass to group operations directly.
   */
  signingPrivateKey: string;
  keyPackages: KeyPackageResult[];
  /**
   * Opaque session handle — use this for all group operations this session
   * without re-loading the private key bytes over IPC.
   */
  keyHandle: string;
}

export interface MlsMemberInfo {
  leafIndex: number;
  identity: string;
  encryptionKey: string;
  signatureKey: string;
}

export interface MlsGroupInfo {
  groupId: string;
  epoch: number;
  ownLeafIndex: number;
  members: MlsMemberInfo[];
}

/**
 * Result of `addMembers` / `removeMembers` / `leaveGroup`.
 * `commit` must be broadcast to every existing group member.
 * `welcome` (if present) must be sent to the newly added members.
 * `epoch` is the group epoch after this commit was applied.
 */
export interface MlsCommitOut {
  /** Base64 TLS-serialized MlsMessage (commit) */
  commit: string;
  /** Base64 TLS-serialized MlsMessage (welcome), present when members were added */
  welcome: string | null;
  /** Group epoch after this commit was applied */
  epoch: number;
}

/**
 * Result of `rejoinGroup`.
 * The `externalCommit` must be broadcast to all existing group members.
 */
export interface MlsRejoinOut {
  groupInfo: MlsGroupInfo;
  /** Base64 TLS-serialized external commit — broadcast to all group members */
  externalCommit: string;
}

/**
 * Result of `processMessage`.
 *
 * Check `kind` first:
 * - `"application"` — `plaintext` contains the decrypted bytes (base64).
 * - `"commit"` — the group state has been advanced; inspect `removedLeafIndices`
 *   and `addedMembers` for membership changes. `epoch` reflects the new epoch.
 * - `"proposal"` — a pending proposal has been queued; a commit is needed next.
 */
export interface MlsProcessedMessage {
  kind: 'application' | 'commit' | 'proposal';
  /** Decrypted application data (base64), only set when kind === "application" */
  plaintext: string | null;
  /** True when the commit removed the local member from the group */
  selfRemoved: boolean;
  addedMembers: MlsMemberInfo[];
  removedLeafIndices: number[];
  /** Identity of the message sender (from their BasicCredential) */
  senderIdentity: string | null;
  /** Epoch after applying the commit, only set when kind === "commit" */
  epoch: number | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class MlsService {

  public keyHandle = signal<string | undefined>(undefined)

  private readonly _groupQueues = new Map<string, Promise<unknown>>();
  private readonly _groupRegistry = new LazyStore('mls-group-registry.json');

  // -------------------------------------------------------------------------
  // Group registry — maps conversationId → MLS groupId (persisted)
  // -------------------------------------------------------------------------

  async registerGroupForConversation(conversationId: string, mlsGroupId: string): Promise<void> {
    await this._groupRegistry.set(conversationId, mlsGroupId);
    await this._groupRegistry.save();
  }

  async getGroupIdForConversation(conversationId: string): Promise<string | null> {
    return (await this._groupRegistry.get<string>(conversationId)) ?? null;
  }

  /**
   * Serializes `op` behind any in-flight operation for `groupId`.
   * The queue continues even when a prior operation rejects.
   */
  private serialized<T>(groupId: string, op: () => Promise<T>): Observable<T> {
    const prev = this._groupQueues.get(groupId) ?? Promise.resolve();
    const task = prev.then(() => op(), () => op());
    this._groupQueues.set(groupId, task.then(() => undefined, () => undefined));
    return from(task);
  }

  // -------------------------------------------------------------------------
  // Key handle management
  // -------------------------------------------------------------------------

  /**
   * Load a signing key into the Rust session store and return an opaque handle.
   *
   * Call this once per session unlock. All subsequent group operations should
   * use the returned handle — the private key bytes never cross IPC again.
   */
  loadSigningKey(
    signingPublicKeyB64: string,
    signingPrivateKeyB64: string,
    identity: string,
  ): Observable<string> {
    return from(invoke<string>('mls_load_signing_key', {
      signingPublicKeyB64,
      signingPrivateKeyB64,
      identity,
    }));
  }

  /**
   * Remove a signing key from the Rust session store.
   * Call this on session lock / logout to clear key material from memory.
   */
  unloadSigningKey(keyHandle: string): Observable<void> {
    return from(invoke<void>('mls_unload_signing_key', { keyHandle }));
  }

  // -------------------------------------------------------------------------
  // Key package generation
  // -------------------------------------------------------------------------

  /**
   * Generate a batch of fresh key packages for this identity.
   * Call this once per device registration. Store `signingPrivateKey` and each
   * `initPrivateKey` encrypted under the master key; upload each `keyPackage`
   * and `signingPublicKey` to the server.
   * The returned `keyHandle` is immediately usable this session.
   */
  generateKeyPackages(identity: string, count: number): Observable<MlsKeyPackageBatch> {
    return from(invoke<MlsKeyPackageBatch>('generate_mls_key_packages', { identity, count }));
  }

  /**
   * Generate additional key packages using an existing signing key handle.
   *
   * Unlike `generateKeyPackages`, this does not create a new Ed25519 keypair —
   * it reuses the key already loaded under `keyHandle`. Use this to replenish
   * the server's key package supply without rotating the signing key.
   *
   * @param keyHandle  Handle returned by `loadSigningKey` or `generateKeyPackages`.
   * @param count      Number of key packages to generate.
   */
  generateAdditionalKeyPackages(keyHandle: string, count: number): Observable<KeyPackageResult[]> {
    return from(invoke<KeyPackageResult[]>('mls_generate_key_packages_with_handle', { keyHandle, count }));
  }

  // -------------------------------------------------------------------------
  // Group lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create a new MLS group with a specific group ID.
   *
   * @param groupIdB64  Arbitrary group ID bytes (base64).
   * @param keyHandle   Handle returned by `loadSigningKey` or `generateKeyPackages`.
   */
  createGroup(
    groupIdB64: string,
    keyHandle: string,
  ): Observable<MlsGroupInfo> {
    return this.serialized(groupIdB64, () =>
      invoke<MlsGroupInfo>('mls_create_group', { groupIdB64, keyHandle })
    );
  }

  /**
   * Add one or more members to an existing group.
   *
   * @param keyPackagesB64  List of base64 TLS-serialized KeyPackages from the
   *                        invitees' `generateKeyPackages` call.
   * @returns  `commit` — broadcast to all current members.
   *           `welcome` — send only to the newly added members.
   */
  addMembers(
    groupIdB64: string,
    keyHandle: string,
    keyPackagesB64: string[],
  ): Observable<MlsCommitOut> {
    return this.serialized(groupIdB64, () =>
      invoke<MlsCommitOut>('mls_add_members', { groupIdB64, keyHandle, keyPackagesB64 })
    );
  }

  /**
   * Join a group from a Welcome message received from an existing member.
   *
   * @param welcomeB64  Base64 TLS-serialized Welcome (from `addMembers().welcome`).
   * @param keyHandle   Handle for the signing key whose KeyPackage was in the Welcome.
   */
  joinGroup(
    welcomeB64: string,
    keyHandle: string,
  ): Observable<MlsGroupInfo> {
    return from(invoke<MlsGroupInfo>('mls_join_group', { welcomeB64, keyHandle }));
  }

  /**
   * Leave the group by proposing and committing self-removal.
   * The returned `commit` must be broadcast to remaining members.
   * The local group state is automatically cleaned up.
   */
  leaveGroup(
    groupIdB64: string,
    keyHandle: string,
  ): Observable<MlsCommitOut> {
    return this.serialized(groupIdB64, () =>
      invoke<MlsCommitOut>('mls_leave_group', { groupIdB64, keyHandle })
    );
  }

  /**
   * Export a TLS-serialized GroupInfo blob for external commit / offline recovery.
   * Publish this via the server so members who missed commits can re-sync.
   */
  exportGroupInfo(
    groupIdB64: string,
    keyHandle: string,
  ): Observable<string> {
    return from(invoke<string>('mls_export_group_info', { groupIdB64, keyHandle }));
  }

  /**
   * Re-join a group via external commit after missing commits while offline.
   *
   * @param groupInfoB64  TLS-serialized GroupInfo from `exportGroupInfo`.
   * @param keyHandle     Handle for the re-joining member's signing key.
   */
  rejoinGroup(
    groupInfoB64: string,
    keyHandle: string,
  ): Observable<MlsRejoinOut> {
    return from(invoke<MlsRejoinOut>('mls_rejoin_group', { groupInfoB64, keyHandle }));
  }

  /**
   * Permanently delete a group from the local store.
   * Call this after being removed, after `leaveGroup`, or for GDPR erasure.
   */
  deleteGroup(groupIdB64: string): Observable<void> {
    return from(
      invoke<void>('mls_delete_group', { groupIdB64 }).then(v => {
        this._groupQueues.delete(groupIdB64);
        return v;
      })
    );
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  /**
   * Encrypt and send an application message to the group.
   *
   * @param plaintextB64  The message bytes to encrypt (base64).
   * @returns  Base64 TLS-serialized ciphertext to broadcast to the group.
   */
  sendMessage(
    groupIdB64: string,
    keyHandle: string,
    plaintextB64: string,
  ): Observable<string> {
    return this.serialized(groupIdB64, () =>
      invoke<string>('mls_send_message', { groupIdB64, keyHandle, plaintextB64 })
    );
  }

  /**
   * Process an incoming MLS message (application data, commit, or proposal).
   *
   * Commits are merged immediately and the group state advances.
   * Proposals are queued; a subsequent commit (from any member) applies them.
   * Returns a `WrongEpoch` error when the message is from a future epoch —
   * buffer it and retry after receiving the missing commit.
   *
   * @param messageB64  Base64 TLS-serialized MlsMessage from the server.
   */
  processMessage(
    groupIdB64: string,
    messageB64: string,
  ): Observable<MlsProcessedMessage> {
    return this.serialized(groupIdB64, () =>
      invoke<MlsProcessedMessage>('mls_process_message', { groupIdB64, messageB64 })
    );
  }

  /**
   * Verify that `senderIdentity` is present in the current group roster.
   *
   * Call this after `processMessage` for application messages to guard against
   * a compromised server replaying a valid ciphertext with a spoofed credential.
   * Returns `true` if the sender is known, `false` otherwise.
   */
  verifySenderInRoster(
    senderIdentity: string,
    groupIdB64: string,
  ): Observable<boolean> {
    return this.getMembers(groupIdB64).pipe(
      map(members => members.some(m => m.identity === senderIdentity))
    );
  }

  /**
   * Process a message and immediately verify the sender against the roster.
   * Throws an `MlsTypedError` with `kind === 'UnknownSender'` if the sender
   * cannot be found in the group member list after processing.
   */
  processAndVerifyMessage(
    groupIdB64: string,
    messageB64: string,
  ): Observable<MlsProcessedMessage> {
    return this.processMessage(groupIdB64, messageB64).pipe(
      switchMap(msg => {
        if (msg.kind === 'application' && msg.senderIdentity) {
          return this.verifySenderInRoster(msg.senderIdentity, groupIdB64).pipe(
            map(known => {
              if (!known) {
                const err: MlsTypedError = {
                  kind: 'UnknownSender',
                  message: `${msg.senderIdentity} is not in the group roster`,
                };
                throw err;
              }
              return msg;
            })
          );
        }
        return of(msg);
      })
    );
  }

  /**
   * Remove members from the group by leaf index.
   *
   * @param leafIndices  Leaf indices of the members to remove (from `MlsMemberInfo.leafIndex`).
   * @returns  `commit` — broadcast to all remaining members.
   */
  removeMembers(
    groupIdB64: string,
    keyHandle: string,
    leafIndices: number[],
  ): Observable<MlsCommitOut> {
    return this.serialized(groupIdB64, () =>
      invoke<MlsCommitOut>('mls_remove_members', { groupIdB64, keyHandle, leafIndices })
    );
  }

  // -------------------------------------------------------------------------
  // Group queries
  // -------------------------------------------------------------------------

  /** Return the current member list for a group. */
  getMembers(groupIdB64: string): Observable<MlsMemberInfo[]> {
    return from(invoke<MlsMemberInfo[]>('mls_get_members', { groupIdB64 }));
  }

  /** Return current group metadata (epoch, own leaf index, members). */
  getGroupInfo(groupIdB64: string): Observable<MlsGroupInfo> {
    return from(invoke<MlsGroupInfo>('mls_get_group_info', { groupIdB64 }));
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Initialize the MLS storage layer and restore any previously persisted state.
   *
   * Call this once on app startup before any group operations. The Rust layer
   * will locate the app data directory automatically.
   *
   * @returns `true` when state was restored from disk, `false` when starting fresh.
   */
  initStorage(): Observable<boolean> {
    return from(invoke<boolean>('mls_init_storage'));
  }

  /**
   * Export the full MLS state as an AES-256-GCM–encrypted blob for cloud backup.
   *
   * `encryptionKeyB64` must be a base64-encoded 32-byte key (e.g. derived from
   * the user's master key). Store the returned blob in the cloud; use
   * `importState` on a new device to restore.
   */
  exportState(encryptionKeyB64: string): Observable<string> {
    return from(invoke<string>('mls_export_state', { encryptionKeyB64 }));
  }

  /**
   * Restore MLS state from an encrypted export blob produced by `exportState`.
   *
   * Clears all current in-memory group state, decrypts and restores the stored
   * groups, and writes the restored state to disk. Call `loadSigningKey` /
   * `autoUnlock` separately to re-establish the signing key session handle.
   */
  importState(encryptedB64: string, encryptionKeyB64: string): Observable<void> {
    return from(invoke<void>('mls_import_state', { encryptedB64, encryptionKeyB64 }));
  }

  // -------------------------------------------------------------------------
  // Secure key storage (OS keychain / Credential Manager)
  // -------------------------------------------------------------------------

  private secureKey(deviceId: string, field: 'pub' | 'priv' | 'identity'): string {
    return `alpine_mls_${deviceId}_${field}`;
  }

  /**
   * Store the signing key from a freshly generated batch in the OS keychain.
   * Call once after `generateKeyPackages` on first device registration.
   * On subsequent launches use `autoUnlock` instead of asking the user.
   */
  persistSigningKey(
    deviceId: string,
    batch: MlsKeyPackageBatch,
    identity: string,
  ): Observable<void> {
    return from(
      Promise.all([
        secureStorage.setItem(this.secureKey(deviceId, 'pub'), batch.signingPublicKey),
        secureStorage.setItem(this.secureKey(deviceId, 'priv'), batch.signingPrivateKey),
        secureStorage.setItem(this.secureKey(deviceId, 'identity'), identity),
      ]).then(() => undefined),
    );
  }

  /**
   * Load the signing key from the OS keychain and return a ready-to-use handle.
   * Call this on every app launch instead of prompting the user for credentials.
   * Throws `MlsTypedError { kind: 'KeyNotFound' }` if no key has been stored yet.
   */
  autoUnlock(deviceId: string): Observable<string> {
    return from(
      Promise.all([
        secureStorage.getItem(this.secureKey(deviceId, 'pub')),
        secureStorage.getItem(this.secureKey(deviceId, 'priv')),
        secureStorage.getItem(this.secureKey(deviceId, 'identity')),
      ]),
    ).pipe(
      switchMap(([pub, priv, identity]) => {
        if (!pub || !priv || !identity) {
          const err: MlsTypedError = { kind: 'KeyNotFound', message: 'No signing key in secure storage — device not registered' };
          throw err;
        }
        return this.loadSigningKey(pub, priv, identity).pipe(map(keyHandle => {
          this.keyHandle.set(keyHandle);
          return keyHandle;
        }));
      }),
    );
  }

  /**
   * Remove the stored signing key from the OS keychain.
   * Call on logout, account deletion, or device de-registration.
   */
  clearStoredSigningKey(deviceId: string): Observable<void> {
    return from(
      Promise.all([
        secureStorage.removeItem(this.secureKey(deviceId, 'pub')),
        secureStorage.removeItem(this.secureKey(deviceId, 'priv')),
        secureStorage.removeItem(this.secureKey(deviceId, 'identity')),
      ]).then(() => undefined),
    );
  }

  // -------------------------------------------------------------------------
  // Device identity
  // -------------------------------------------------------------------------

  async getOrCreateDeviceIdentifier(): Promise<string> {
    const store = new LazyStore('settings.json');
    const KEY = 'mls_device_id';

    let deviceId = await store.get<{ value: string }>(KEY);

    if (!deviceId) {
      deviceId = { value: crypto.randomUUID() };
      await store.set(KEY, deviceId);
      await store.save();
    }

    return deviceId.value;
  }
}
