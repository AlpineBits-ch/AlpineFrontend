import {inject, Injectable, signal} from '@angular/core';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {from, Observable, of} from 'rxjs';
import {map, switchMap} from 'rxjs/operators';
import {LazyStore} from '@tauri-apps/plugin-store';
import {secureStorage} from 'tauri-plugin-secure-storage-api';
import {DeviceIdentityService} from './device-identity.service';

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
            return {kind, message: msg.slice(kind.length + 1).trimStart()};
        }
    }
    return {kind: 'MlsError', message: msg};
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface KeyPackageResult {
    /** TLS-serialized KeyPackage (base64) -upload to server */
    keyPackage: string;
    /** HPKE init private key (base64) -store encrypted under the master key */
    initPrivateKey: string;
}

export interface MlsKeyPackageBatch {
    /** Ed25519 public key (base64) */
    signingPublicKey: string;
    /**
     * Ed25519 private key (base64) -store encrypted under the master key.
     * On each session unlock pass this to `loadSigningKey` to get a `keyHandle`,
     * then discard from JS memory. Never pass to group operations directly.
     */
    signingPrivateKey: string;
    keyPackages: KeyPackageResult[];
    /**
     * Opaque session handle -use this for all group operations this session
     * without re-loading the private key bytes over IPC.
     */
    keyHandle: string;
}

/** What a reviewer is shown before vouching for someone's admission. */
export interface MlsKeyPackageInfo {
    /** The user id this package claims, from its BasicCredential. */
    identity: string;
    /** Long-lived Ed25519 signature key (base64). */
    signaturePublicKey: string;
    /**
     * Human-comparable fingerprint of the *signature* key, in five-character groups.
     *
     * Stable across every key package a device mints, which is what makes it usable out of band -
     * a per-package value would differ on every request and two people could never agree on it.
     */
    signatureKeyFingerprint: string;
    /** SHA-256 of the key package bytes (hex). Binds an approval to these exact bytes. */
    keyPackageHash: string;
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
    /**
     * GroupInfo for the epoch this commit *establishes*, produced by the commit itself.
     *
     * Publish this rather than calling {@link MlsService.exportGroupInfo}: an exported GroupInfo can
     * only describe the epoch the group is on right now, and a commit is deliberately not merged
     * until the server accepts it - so every published GroupInfo used to be one epoch stale, and a
     * device recovering by external commit landed behind the group it was rejoining.
     */
    groupInfo: string | null;
}

/**
 * Result of `rejoinGroup`.
 * The `externalCommit` must be broadcast to all existing group members.
 */
export interface MlsRejoinOut {
    groupInfo: MlsGroupInfo;
    /** Base64 TLS-serialized external commit -broadcast to all group members */
    externalCommit: string;
}

/**
 * Result of `processMessage`.
 *
 * Check `kind` first:
 * - `"application"` -`plaintext` contains the decrypted bytes (base64).
 * - `"commit"` -the group state has been advanced; inspect `removedLeafIndices`
 *   and `addedMembers` for membership changes. `epoch` reflects the new epoch.
 * - `"proposal"` -a pending proposal has been queued; a commit is needed next.
 */
export interface MlsProcessedMessage {
    /**
     * `"buffered"` means the message is from an epoch this device has not reached yet. It is held
     * rather than dropped - the wire copy decrypts exactly once - and
     * {@link MlsService.drainPendingMessages} returns it after the missing commits are applied.
     */
    kind: 'application' | 'commit' | 'proposal' | 'buffered';
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

/** A message that arrived early and became readable once its commit was applied. */
export interface MlsReplayedMessage {
    /** The id supplied when the message was first handed to {@link MlsService.processMessage}. */
    messageId: string | null;
    /** Decrypted bytes, base64. */
    plaintext: string;
    senderIdentity: string | null;
    epoch: number;
}

/** What `mls_import_backup` hands back once the §D envelope has been opened and applied. */
export interface MlsBackupImportResult {
    userId: string;
    /** The device the backup was taken on - not necessarily this one. */
    deviceId: string;
    createdAt: string;
    appVersion: string;
    identity: string;
    /** Session handle for the restored signing key, immediately usable. */
    keyHandle: string;
    /**
     * False on a new device. Cloning ratchet state onto a second concurrently-live device reuses
     * sender-ratchet generations - openmls treats the repeat as a replay, so at least one device
     * becomes unable to send - and voids forward secrecy for that leaf.
     */
    engineRestored: boolean;
    groupRegistry: Record<string, string | number>;
    messageCache: Record<string, string>;
}

/**
 * Every MLS operation goes through the Rust engine, which exists only inside Tauri.
 *
 * Guarded explicitly rather than left to chance: the app happens not to boot in a browser today,
 * so nothing here was ever reached from one - but "it crashes earlier" is not an access control.
 * A web build that got this far would silently hold no keys and, without this, would report
 * success for operations that never happened.
 */
export class MlsUnavailableError extends Error {
    constructor() {
        super('MLS is unavailable: this build has no local MLS engine.');
    }
}

function requireTauri(): void {
    if (!isTauri()) throw new MlsUnavailableError();
}

/** One sealed entry in the plaintext message cache. */
interface CachedMessage {
    v: 1;
    /** When it was cached, for pruning. */
    at: number;
    /** AES-GCM nonce, base64. */
    iv: string;
    /** Sealed plaintext, base64. */
    ct: string;
}

function toB64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function fromB64(b64: string): ArrayBuffer {
    const binary = atob(b64);
    const out = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out.buffer;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({providedIn: 'root'})
export class MlsService {

    public keyHandle = signal<string | undefined>(undefined)

    private readonly _groupQueues = new Map<string, Promise<unknown>>();
    private readonly _groupRegistry = new LazyStore('mls-group-registry.json');
    private readonly _messageCache = new LazyStore('mls-message-cache.json');
    private readonly deviceIdentity = inject(DeviceIdentityService);
    private _cacheKey: Promise<CryptoKey> | null = null;

    // -------------------------------------------------------------------------
    // Group registry - maps (contextId, generation) → MLS groupId (persisted)
    //
    // Encryption can be switched off and back on, and each stretch is a distinct MLS group whose
    // epochs restart at zero. Keying by context alone would have the second group overwrite the
    // first, and every message from the first era would then be decrypted against the wrong keys -
    // so the generation is part of the key, and the old entry is deliberately kept.
    // -------------------------------------------------------------------------

    private static groupKey(contextId: string, generation: number): string {
        return `${contextId}#${generation}`;
    }

    /** Key under which we remember which generation a context is currently on. */
    private static activeGenerationKey(contextId: string): string {
        return `${contextId}#active`;
    }

    async registerGroup(contextId: string, generation: number, mlsGroupId: string): Promise<void> {
        await this._groupRegistry.set(MlsService.groupKey(contextId, generation), mlsGroupId);
        await this._groupRegistry.set(MlsService.activeGenerationKey(contextId), generation);
        await this._groupRegistry.save();
    }

    async getGroupId(contextId: string, generation: number): Promise<string | null> {
        return (await this._groupRegistry.get<string>(MlsService.groupKey(contextId, generation))) ?? null;
    }

    /** The generation this device last saw as live for the context, if any. */
    async getKnownGeneration(contextId: string): Promise<number | null> {
        return (await this._groupRegistry.get<number>(MlsService.activeGenerationKey(contextId))) ?? null;
    }

    /**
     * Records that a context is no longer encrypted, without forgetting the group that encrypted
     * it - the messages from that era are still in the history and still need its keys.
     */
    async clearActiveGeneration(contextId: string): Promise<void> {
        await this._groupRegistry.delete(MlsService.activeGenerationKey(contextId));
        await this._groupRegistry.save();
    }

    /** Group id for whichever generation this device believes is live. */
    async getActiveGroupId(contextId: string): Promise<string | null> {
        const generation = await this.getKnownGeneration(contextId);
        if (generation === null) return null;
        return this.getGroupId(contextId, generation);
    }

    async clearGroupRegistry(): Promise<void> {
        await this._groupRegistry.clear();
        await this._groupRegistry.save();
    }

    // -------------------------------------------------------------------------
    // Message cache -MLS ratchets forward only, so a message decrypts from the wire exactly once.
    // Without this, paging back through history shows nothing.
    //
    // It therefore holds the plaintext of every message this device has ever read, which made it a
    // larger at-rest exposure than the ciphertext on the server. Sealed under the same OS
    // keychain-held key as the engine state, and bounded - it used to grow without limit for the
    // life of the installation.
    // -------------------------------------------------------------------------

    /** Entries kept before the oldest are dropped. Roughly a year of an active conversation. */
    private static readonly MESSAGE_CACHE_LIMIT = 5_000;

    async cacheMessage(messageId: string, plaintextB64: string): Promise<void> {
        const sealed = await this.seal(plaintextB64);
        await this._messageCache.set(messageId, {v: 1, at: Date.now(), ...sealed} satisfies CachedMessage);
        await this.pruneMessageCache();
        await this._messageCache.save();
    }

    async getCachedMessage(messageId: string): Promise<string | null> {
        const entry = await this._messageCache.get<CachedMessage | string>(messageId);
        if (!entry) return null;

        // Entries written before the cache was sealed are bare base64. Read once, rewritten sealed,
        // rather than discarded - they are the only copy of that message's plaintext.
        if (typeof entry === 'string') {
            await this.cacheMessage(messageId, entry);
            return entry;
        }

        try {
            return await this.unseal(entry);
        } catch {
            // A cache entry we cannot open is no worse than a cache miss: the message renders as
            // undecryptable rather than as garbage.
            return null;
        }
    }

    /** Drops the plaintext cache. Part of every local-wipe path. */
    async clearMessageCache(): Promise<void> {
        await this._messageCache.clear();
        await this._messageCache.save();
    }

    private async pruneMessageCache(): Promise<void> {
        const entries = await this._messageCache.entries<CachedMessage | string>();
        if (entries.length <= MlsService.MESSAGE_CACHE_LIMIT) return;

        const aged = entries
            .map(([id, value]) => ({id, at: typeof value === 'string' ? 0 : value.at ?? 0}))
            .sort((a, b) => a.at - b.at);

        // Oldest first. Losing the oldest plaintext is the least bad outcome available: those
        // messages are the least likely to be scrolled back to, and the ratchet cannot recover any
        // of them either way.
        const excess = aged.slice(0, entries.length - MlsService.MESSAGE_CACHE_LIMIT);
        for (const {id} of excess) await this._messageCache.delete(id);
    }

    private async seal(plaintextB64: string): Promise<{ iv: string; ct: string }> {
        const key = await this.cacheKey();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt(
            {name: 'AES-GCM', iv},
            key,
            new TextEncoder().encode(plaintextB64),
        );
        return {iv: toB64(iv), ct: toB64(new Uint8Array(ct))};
    }

    private async unseal(entry: CachedMessage): Promise<string> {
        const key = await this.cacheKey();
        const plain = await crypto.subtle.decrypt(
            {name: 'AES-GCM', iv: fromB64(entry.iv)},
            key,
            fromB64(entry.ct),
        );
        return new TextDecoder().decode(plain);
    }

    private async cacheKey(): Promise<CryptoKey> {
        this._cacheKey ??= this.localStateKey().then(raw =>
            crypto.subtle.importKey('raw', fromB64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']),
        );
        return this._cacheKey;
    }

    /**
     * The 32-byte key the engine state and the message cache are both sealed under, held by the OS
     * keychain and never written to disk beside what it protects.
     *
     * Minted on first use. A device that somehow loses it loses the local cache and has to
     * re-register, which is recoverable; leaving every private key in cleartext on disk is not.
     */
    private async localStateKey(): Promise<string> {
        const deviceId = await this.deviceIdentity.deviceId();
        const name = `alpine_mls_${deviceId}_statekey`;

        const existing = await secureStorage.getItem(name);
        if (existing) return existing;

        const minted = toB64(crypto.getRandomValues(new Uint8Array(32)));
        await secureStorage.setItem(name, minted);
        return minted;
    }

    /**
     * Load a signing key into the Rust session store and return an opaque handle.
     *
     * Call this once per session unlock. All subsequent group operations should
     * use the returned handle -the private key bytes never cross IPC again.
     */
    loadSigningKey(
        signingPublicKeyB64: string,
        signingPrivateKeyB64: string,
        identity: string,
    ): Observable<string> {
        return from(this.call<string>('mls_load_signing_key', {
            signingPublicKeyB64,
            signingPrivateKeyB64,
            identity,
        }));
    }

    // -------------------------------------------------------------------------
    // Key handle management
    // -------------------------------------------------------------------------

    /**
     * Remove a signing key from the Rust session store.
     * Call this on session lock / logout to clear key material from memory.
     */
    unloadSigningKey(keyHandle: string): Observable<void> {
        return from(this.call<void>('mls_unload_signing_key', {keyHandle}));
    }

    /**
     * Generate a batch of fresh key packages for this identity.
     * Call this once per device registration. Store `signingPrivateKey` and each
     * `initPrivateKey` encrypted under the master key; upload each `keyPackage`
     * and `signingPublicKey` to the server.
     * The returned `keyHandle` is immediately usable this session.
     */
    generateKeyPackages(identity: string, count: number): Observable<MlsKeyPackageBatch> {
        return from(this.call<MlsKeyPackageBatch>('generate_mls_key_packages', {identity, count}));
    }

    // -------------------------------------------------------------------------
    // Key package generation
    // -------------------------------------------------------------------------

    /**
     * Generate additional key packages using an existing signing key handle.
     *
     * Unlike `generateKeyPackages`, this does not create a new Ed25519 keypair -
     * it reuses the key already loaded under `keyHandle`. Use this to replenish
     * the server's key package supply without rotating the signing key.
     *
     * @param keyHandle  Handle returned by `loadSigningKey` or `generateKeyPackages`.
     * @param count      Number of key packages to generate.
     */
    generateAdditionalKeyPackages(keyHandle: string, count: number): Observable<KeyPackageResult[]> {
        return from(this.call<KeyPackageResult[]>('mls_generate_key_packages_with_handle', {keyHandle, count}));
    }

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
            this.call<MlsGroupInfo>('mls_create_group', {groupIdB64, keyHandle})
        );
    }

    // -------------------------------------------------------------------------
    // Group lifecycle
    // -------------------------------------------------------------------------

    /**
     * Add one or more members to an existing group.
     *
     * @param keyPackagesB64  List of base64 TLS-serialized KeyPackages from the
     *                        invitees' `generateKeyPackages` call.
     * @returns  `commit` -broadcast to all current members.
     *           `welcome` -send only to the newly added members.
     */
    addMembers(
        groupIdB64: string,
        keyHandle: string,
        keyPackagesB64: string[],
    ): Observable<MlsCommitOut> {
        return this.serialized(groupIdB64, () =>
            this.call<MlsCommitOut>('mls_add_members', {groupIdB64, keyHandle, keyPackagesB64})
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
        return from(this.call<MlsGroupInfo>('mls_join_group', {welcomeB64, keyHandle}));
    }

    /**
     * Leave the group.
     *
     * MLS does not let a member commit their own removal, so this produces a Remove **proposal**,
     * not a commit - despite the field being named `commit` for shape compatibility with the other
     * operations. Publish it like a commit; a remaining member then turns it into one via
     * {@link commitPendingProposals}. `epoch` is meaningless here and comes back as 0.
     *
     * Local group state is dropped immediately, so this device loses access the moment it asks to
     * leave, whether or not anyone ever commits the proposal.
     */
    leaveGroup(
        groupIdB64: string,
        keyHandle: string,
    ): Observable<MlsCommitOut> {
        return this.serialized(groupIdB64, () =>
            this.call<MlsCommitOut>('mls_leave_group', {groupIdB64, keyHandle})
        );
    }

    /**
     * Commit every pending proposal for a group - in practice, the Remove proposal a departing
     * member left behind.
     *
     * Without this, {@link leaveGroup} can never complete: the leaver has erased their own state
     * but the group still lists them, so it keeps encrypting to a member who cannot read any of it.
     */
    commitPendingProposals(
        groupIdB64: string,
        keyHandle: string,
    ): Observable<MlsCommitOut> {
        return this.serialized(groupIdB64, () =>
            this.call<MlsCommitOut>('mls_commit_pending_proposals', {groupIdB64, keyHandle})
        );
    }

    /**
     * This device's own identity fingerprint, for reading out to whoever is reviewing its admission.
     *
     * Free to call. Deriving it from a freshly minted key package instead would consume one per
     * read - they are single-use and finite, so a screen showing your own fingerprint would quietly
     * drain the supply and eventually leave this device unaddable to any group.
     */
    ownFingerprint(keyHandle: string): Observable<string> {
        return from(this.call<string>('mls_signing_key_fingerprint', {keyHandle}));
    }

    /**
     * Inspect a key package before vouching for it, or before adding it.
     *
     * Validated, not merely parsed - a reviewer must never be shown an identity lifted from
     * something that would be refused at add time.
     */
    inspectKeyPackage(keyPackageB64: string): Observable<MlsKeyPackageInfo> {
        return from(this.call<MlsKeyPackageInfo>('mls_inspect_key_package', {keyPackageB64}));
    }

    /**
     * Apply a commit staged by {@link addMembers} / {@link removeMembers} /
     * {@link commitPendingProposals}, once the server has accepted it.
     *
     * Safe to retry: merging with nothing staged is a no-op, so a client that published
     * successfully and then died before merging can simply merge again on the next launch.
     *
     * @returns the group's epoch after the merge.
     */
    mergePendingCommit(groupIdB64: string): Observable<number> {
        return this.serialized(groupIdB64, () =>
            this.call<number>('mls_merge_pending_commit', {groupIdB64})
        );
    }

    /**
     * Discard a staged commit the server refused, leaving the group exactly where it was.
     *
     * This is the losing side of a concurrent-commit race. Applying a commit the server did not
     * take would fork this device off the group permanently, so the commit is thrown away and
     * re-issued against the epoch that actually won.
     */
    clearPendingCommit(groupIdB64: string): Observable<void> {
        return this.serialized(groupIdB64, () =>
            this.call<void>('mls_clear_pending_commit', {groupIdB64})
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
        return from(this.call<string>('mls_export_group_info', {groupIdB64, keyHandle}));
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
        return from(this.call<MlsRejoinOut>('mls_rejoin_group', {groupInfoB64, keyHandle}));
    }

    /**
     * Permanently delete a group from the local store.
     * Call this after being removed, after `leaveGroup`, or for GDPR erasure.
     */
    deleteGroup(groupIdB64: string): Observable<void> {
        // Serialized like every other mutation. Deleting outside the queue could tear the group out
        // from under a decrypt or a staged commit that was already in flight for it, which reads as
        // corruption rather than as the removal it is.
        return this.serialized(groupIdB64, () =>
            this.call<void>('mls_delete_group', {groupIdB64}),
        ).pipe(map(() => {
            // Dropped only after the delete lands, so a queued operation behind it still runs
            // against the same chain rather than jumping ahead of it.
            this._groupQueues.delete(groupIdB64);
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
        keyHandle: string,
        plaintextB64: string,
    ): Observable<{ ciphertext: string; epoch: number }> {
        return this.serialized(groupIdB64, () =>
            this.call<{ ciphertext: string; epoch: number }>('mls_send_message', {groupIdB64, keyHandle, plaintextB64})
        );
    }

    // -------------------------------------------------------------------------
    // Messaging
    // -------------------------------------------------------------------------

    /**
     * Process an incoming MLS message (application data, commit, or proposal).
     *
     * Commits are merged immediately and the group state advances.
     * Proposals are queued; a subsequent commit (from any member) applies them.
     * Returns a `WrongEpoch` error when the message is from a future epoch -
     * buffer it and retry after receiving the missing commit.
     *
     * @param messageB64  Base64 TLS-serialized MlsMessage from the server.
     */
    processMessage(
        groupIdB64: string,
        messageB64: string,
        messageId?: string,
    ): Observable<MlsProcessedMessage> {
        return this.serialized(groupIdB64, () =>
            this.call<MlsProcessedMessage>('mls_process_message', {groupIdB64, messageB64, messageId})
        );
    }

    /**
     * Returns messages that arrived before the commit that made them readable.
     *
     * Call after a catch-up has applied commits. Usually empty; when it is not, each entry is a
     * message that would otherwise have been lost outright - a message decrypts from the wire
     * exactly once, so the alternative to holding it was dropping it.
     */
    drainPendingMessages(groupIdB64: string): Observable<MlsReplayedMessage[]> {
        return this.serialized(groupIdB64, () =>
            this.call<MlsReplayedMessage[]>('mls_drain_pending_messages', {groupIdB64})
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
     * @returns  `commit` -broadcast to all remaining members.
     */
    removeMembers(
        groupIdB64: string,
        keyHandle: string,
        leafIndices: number[],
    ): Observable<MlsCommitOut> {
        return this.serialized(groupIdB64, () =>
            this.call<MlsCommitOut>('mls_remove_members', {groupIdB64, keyHandle, leafIndices})
        );
    }

    /** Return the current member list for a group. */
    getMembers(groupIdB64: string): Observable<MlsMemberInfo[]> {
        return from(this.call<MlsMemberInfo[]>('mls_get_members', {groupIdB64}));
    }

    // -------------------------------------------------------------------------
    // Group queries
    // -------------------------------------------------------------------------

    /** Return current group metadata (epoch, own leaf index, members). */
    getGroupInfo(groupIdB64: string): Observable<MlsGroupInfo> {
        return from(this.call<MlsGroupInfo>('mls_get_group_info', {groupIdB64}));
    }

    /**
     * Initialize the MLS storage layer and restore any previously persisted state.
     *
     * Call this once on app startup before any group operations. The Rust layer
     * will locate the app data directory automatically.
     *
     * @returns `true` when state was restored from disk, `false` when starting fresh.
     */
    initStorage(): Observable<boolean> {
        // The key is fetched here rather than passed in so no caller can forget it and quietly
        // leave the state file in the clear.
        return from(
            this.localStateKey().then(stateKeyB64 =>
                this.call<boolean>('mls_init_storage', {stateKeyB64}),
            ),
        );
    }

    // -------------------------------------------------------------------------
    // Persistence
    // -------------------------------------------------------------------------

    /**
     * Delete the persisted MLS state file and reset all in-memory group state.
     *
     * Use this to recover from a corrupted `mls_state.json` (e.g. when
     * `initStorage` throws because a group is listed but its data is missing).
     * Signing key handles are preserved; the group registry in LazyStore must be
     * cleared separately if needed.
     */
    clearStorage(): Observable<void> {
        return from(this.call<void>('mls_clear_storage'));
    }

    /**
     * Export the full MLS state as an AES-256-GCM–encrypted blob for cloud backup.
     *
     * `encryptionKeyB64` must be a base64-encoded 32-byte key (e.g. derived from
     * the user's master key). Store the returned blob in the cloud; use
     * `importState` on a new device to restore.
     */
    exportState(encryptionKeyB64: string): Observable<string> {
        return from(this.call<string>('mls_export_state', {encryptionKeyB64}));
    }

    /**
     * Restore MLS state from an encrypted export blob produced by `exportState`.
     *
     * Clears all current in-memory group state, decrypts and restores the stored
     * groups, and writes the restored state to disk. Call `loadSigningKey` /
     * `autoUnlock` separately to re-establish the signing key session handle.
     */
    importState(encryptedB64: string, encryptionKeyB64: string): Observable<void> {
        return from(this.call<void>('mls_import_state', {encryptedB64, encryptionKeyB64}));
    }

    // -------------------------------------------------------------------------
    // Key backup (contract §D)
    //
    // `exportState` above covers the openmls provider store and nothing else, which is why it can
    // restore nothing on its own: it omits the signing keypair, the device id, the group registry
    // (without which restored groups are unaddressable) and the message cache. These two assemble
    // and open the full envelope Rust-side, because the signing key deliberately never crosses IPC.
    // -------------------------------------------------------------------------

    /**
     * Seals everything needed to restore this device into one passphrase-protected envelope.
     *
     * @param includeMessageCache plaintext message history. Excluded from the cloud target by
     *        default - it is the most sensitive thing in the envelope and also the thing users most
     *        want back, so the choice is made explicitly rather than for them.
     */
    async exportBackup(
        passphrase: string,
        userId: string,
        appVersion: string,
        includeMessageCache: boolean,
    ): Promise<string> {
        const keyHandle = this.keyHandle();
        if (!keyHandle) throw new Error('MLS session is locked');

        const deviceId = await this.deviceIdentity.deviceId();
        const groupRegistry = Object.fromEntries(
            await this._groupRegistry.entries<string | number>(),
        );

        const messageCache = includeMessageCache ? await this.readMessageCachePlain() : undefined;

        return this.call<string>('mls_export_backup', {
            passphrase,
            userId,
            deviceId,
            appVersion,
            keyHandle,
            groupRegistry,
            messageCache,
        });
    }

    /**
     * Opens a backup envelope and applies it, then restores the registry and message cache locally.
     *
     * The engine is restored only when the blob was taken on *this* device id - see the Rust side
     * for why cloning ratchet state onto a second live device is unsafe. On a new device the
     * caller must re-register, replenish key packages, and get itself re-admitted.
     */
    async importBackup(blob: string, passphrase: string, expectedUserId: string): Promise<MlsBackupImportResult> {
        const currentDeviceId = await this.deviceIdentity.deviceId();

        const result = await this.call<MlsBackupImportResult>('mls_import_backup', {
            blob,
            passphrase,
            expectedUserId,
            currentDeviceId,
        });

        // Without the registry every context reads as unencrypted, whatever the engine holds.
        for (const [key, value] of Object.entries(result.groupRegistry)) {
            await this._groupRegistry.set(key, value);
        }
        await this._groupRegistry.save();

        for (const [messageId, plaintextB64] of Object.entries(result.messageCache)) {
            await this.cacheMessage(messageId, plaintextB64);
        }

        this.keyHandle.set(result.keyHandle);
        return result;
    }

    private async readMessageCachePlain(): Promise<Record<string, string>> {
        const entries = await this._messageCache.entries<CachedMessage | string>();
        const out: Record<string, string> = {};

        for (const [messageId] of entries) {
            const plain = await this.getCachedMessage(messageId);
            if (plain) out[messageId] = plain;
        }
        return out;
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

    // -------------------------------------------------------------------------
    // Secure key storage (OS keychain / Credential Manager)
    // -------------------------------------------------------------------------

    /**
     * Load the signing key from the OS keychain and return a ready-to-use handle.
     * Call this on every app launch instead of prompting the user for credentials.
     * Throws `MlsTypedError { kind: 'KeyNotFound' }` if no key has been stored yet.
     */
    autoUnlock(deviceId: string): Observable<string> {
        return from(
            // A keychain that is momentarily unavailable - locked, service not started, a
            // transient DBus or Credential Manager failure - is not the same thing as a device
            // that has never registered. Collapsing the two sent every hiccup to the registration
            // modal, which mints a *fresh* signing key and orphans the device from every group it
            // belongs to. That is unrecoverable; waiting and retrying is not.
            Promise.all([
                secureStorage.getItem(this.secureKey(deviceId, 'pub')),
                secureStorage.getItem(this.secureKey(deviceId, 'priv')),
                secureStorage.getItem(this.secureKey(deviceId, 'identity')),
            ]).catch((cause: unknown) => {
                const err: MlsTypedError = {
                    kind: 'MlsError',
                    message: `Secure storage is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
                };
                throw err;
            }),
        ).pipe(
            switchMap(([pub, priv, identity]) => {
                if (!pub || !priv || !identity) {
                    const err: MlsTypedError = {
                        kind: 'KeyNotFound',
                        message: 'No signing key in secure storage -device not registered'
                    };
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

    /**
     * @deprecated Prefer `DeviceIdentityService.deviceId()`. Kept so existing MLS call sites
     * keep reading the one identifier rather than growing a second one.
     */
    getOrCreateDeviceIdentifier(): Promise<string> {
        return this.deviceIdentity.deviceId();
    }

    deleteDeviceIdentifier(): Promise<void> {
        return this.deviceIdentity.reset();
    }

    /**
     * Every call into the Rust engine goes through here, so the Tauri guard cannot be forgotten on
     * a new command. Fails closed: outside Tauri there is no engine, and reporting success for an
     * operation that never happened is worse than refusing it.
     */
    private call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        requireTauri();
        return invoke<T>(command, args);
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
    // Device identity
    // -------------------------------------------------------------------------

    private secureKey(deviceId: string, field: 'pub' | 'priv' | 'identity'): string {
        return `alpine_mls_${deviceId}_${field}`;
    }
}
