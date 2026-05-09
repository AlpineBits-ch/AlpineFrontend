import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { from, Observable } from 'rxjs';

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
  /** Ed25519 private key (base64) — store encrypted under the master key */
  signingPrivateKey: string;
  keyPackages: KeyPackageResult[];
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
 * Result of `addMembers` / `removeMembers`.
 * `commit` must be broadcast to every existing group member.
 * `welcome` (if present) must be sent to the newly added members.
 */
export interface MlsCommitOut {
  /** Base64 TLS-serialized MlsMessage (commit) */
  commit: string;
  /** Base64 TLS-serialized MlsMessage (welcome), present when members were added */
  welcome: string | null;
}

/**
 * Result of `processMessage`.
 *
 * Check `kind` first:
 * - `"application"` — `plaintext` contains the decrypted bytes (base64).
 * - `"commit"` — the group state has been advanced; inspect `removedLeafIndices`
 *   and `addedMembers` for membership changes.
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

  /**
   * Generate a batch of fresh key packages for this identity.
   * Call this once per device registration. Store `signingPrivateKey` and each
   * `initPrivateKey` encrypted under the master key; upload each `keyPackage`
   * and `signingPublicKey` to the server.
   */
  generateKeyPackages(identity: string, count: number): Observable<MlsKeyPackageBatch> {
    return from(invoke<MlsKeyPackageBatch>('generate_mls_key_packages', { identity, count }));
  }

  /**
   * Create a new MLS group with a specific group ID.
   *
   * @param groupIdB64   Arbitrary group ID bytes (base64).
   * @param identity     Human-readable identity string for the creator.
   * @param signingPublicKeyB64   Creator's Ed25519 public key (base64).
   * @param signingPrivateKeyB64  Creator's Ed25519 private key (base64).
   */
  createGroup(
    groupIdB64: string,
    identity: string,
    signingPublicKeyB64: string,
    signingPrivateKeyB64: string,
  ): Observable<MlsGroupInfo> {
    return from(invoke<MlsGroupInfo>('mls_create_group', {
      groupIdB64,
      identity,
      signingPublicKeyB64,
      signingPrivateKeyB64,
    }));
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
    signingPublicKeyB64: string,
    signingPrivateKeyB64: string,
    keyPackagesB64: string[],
  ): Observable<MlsCommitOut> {
    return from(invoke<MlsCommitOut>('mls_add_members', {
      groupIdB64,
      signingPublicKeyB64,
      signingPrivateKeyB64,
      keyPackagesB64,
    }));
  }

  /**
   * Join a group from a Welcome message received from an existing member.
   *
   * @param welcomeB64  Base64 TLS-serialized Welcome (from `addMembers().welcome`).
   */
  joinGroup(
    welcomeB64: string,
    signingPublicKeyB64: string,
    signingPrivateKeyB64: string,
  ): Observable<MlsGroupInfo> {
    return from(invoke<MlsGroupInfo>('mls_join_group', {
      welcomeB64,
      signingPublicKeyB64,
      signingPrivateKeyB64,
    }));
  }

  /**
   * Encrypt and send an application message to the group.
   *
   * @param plaintextB64  The message bytes to encrypt (base64).
   * @returns  Base64 TLS-serialized ciphertext to broadcast to the group.
   */
  sendMessage(
    groupIdB64: string,
    signingPublicKeyB64: string,
    signingPrivateKeyB64: string,
    plaintextB64: string,
  ): Observable<string> {
    return from(invoke<string>('mls_send_message', {
      groupIdB64,
      signingPublicKeyB64,
      signingPrivateKeyB64,
      plaintextB64,
    }));
  }

  /**
   * Process an incoming MLS message (application data, commit, or proposal).
   *
   * Commits are merged immediately and the group state advances.
   * Proposals are queued; a subsequent commit (from any member) applies them.
   *
   * @param messageB64  Base64 TLS-serialized MlsMessage from the server.
   */
  processMessage(
    groupIdB64: string,
    messageB64: string,
  ): Observable<MlsProcessedMessage> {
    return from(invoke<MlsProcessedMessage>('mls_process_message', {
      groupIdB64,
      messageB64,
    }));
  }

  /**
   * Remove members from the group by leaf index.
   *
   * @param leafIndices  Leaf indices of the members to remove (from `MlsMemberInfo.leafIndex`).
   * @returns  `commit` — broadcast to all remaining members.
   */
  removeMembers(
    groupIdB64: string,
    signingPublicKeyB64: string,
    signingPrivateKeyB64: string,
    leafIndices: number[],
  ): Observable<MlsCommitOut> {
    return from(invoke<MlsCommitOut>('mls_remove_members', {
      groupIdB64,
      signingPublicKeyB64,
      signingPrivateKeyB64,
      leafIndices,
    }));
  }

  /** Return the current member list for a group. */
  getMembers(groupIdB64: string): Observable<MlsMemberInfo[]> {
    return from(invoke<MlsMemberInfo[]>('mls_get_members', { groupIdB64 }));
  }

  /** Return current group metadata (epoch, own leaf index, members). */
  getGroupInfo(groupIdB64: string): Observable<MlsGroupInfo> {
    return from(invoke<MlsGroupInfo>('mls_get_group_info', { groupIdB64 }));
  }
}
