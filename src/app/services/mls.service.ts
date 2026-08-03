import {inject, Injectable, signal} from '@angular/core';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {firstValueFrom, from, Observable, of} from 'rxjs';
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
    /**
     * The stored signing key belongs to a different account than the one signed in.
     *
     * <p>Never conflated with {@link 'KeyNotFound'}: that one is answered by registering, which
     * mints a fresh keypair and permanently orphans the device from every group it belongs to.
     * Here the correct key exists and simply is not this account's, so the answer is to look at
     * why the account scoping resolved to the wrong device id - not to destroy anything.</p>
     */
    | 'IdentityMismatch'
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
     * The restored signing keypair, base64.
     *
     * <p>Handed back because this pair lives in the OS keychain, not in the engine's store:
     * `autoUnlock` reads it from there on every cold start, so a restore that only loaded it into
     * memory would work until the app was next killed and then look exactly like lost keys.</p>
     */
    signingPublicKey: string;
    signingPrivateKey: string;
    /**
     * False on a new device. Cloning ratchet state onto a second concurrently-live device reuses
     * sender-ratchet generations - openmls treats the repeat as a replay, so at least one device
     * becomes unable to send - and voids forward secrecy for that leaf.
     */
    engineRestored: boolean;
    groupRegistry: Record<string, string | number>;
    messageCache: Record<string, string>;
    /**
     * The account identity keypair (§H), when the envelope carried one.
     *
     * <p>Alpine does not mint these - §H is not ported here - but it can be handed one by a backup
     * venta-mobile wrote. Rust has always returned them; this side declared neither field and threw
     * them away, so importing a mobile backup on Alpine and re-exporting destroyed the account's
     * identity key. Carried and stored so the round trip is lossless.</p>
     */
    accountIdentityPublicKey?: string | null;
    accountIdentityPrivateKey?: string | null;
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

/**
 * Raised when an MLS feature exists in the UI but not in the engine this build shipped.
 *
 * Distinct from an operation that failed: callers must be able to say "not available here" rather
 * than "try again", because retrying a command the binary does not define never succeeds.
 */
export class MlsFeatureUnavailableError extends Error {
    constructor(readonly command: string) {
        super(`This build does not support ${command}.`);
    }
}

/**
 * Whether a rejection is Tauri refusing to resolve the command, rather than the command failing.
 *
 * Matched narrowly - the command's own name has to appear alongside the not-found wording - so a
 * genuine engine error that happens to contain "not found" (a missing group, a missing key) is
 * never mistaken for an absent feature and silently swallowed.
 */
function isCommandNotFound(err: unknown, command: string): boolean {
    const text = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
    return text.includes(command) && /not\s+found|unknown command|not\s+allowed/i.test(text);
}

/**
 * Why a §D backup could not be restored.
 *
 * <p>Separated because the remedies are disjoint and mutually useless. "Wrong passphrase" sends
 * someone to look for a password; "wrong account" sends them to switch account; "not a backup
 * file" sends them to find a different file. Collapsing them - which is what a single
 * `catch { 'Restore failed' }` does - is the same mistake as C2, where an argument rejection was
 * rendered as a credential rejection and told a user to doubt a correct recovery code.</p>
 */
export type MlsBackupImportFailure =
    /** The file is not a §D envelope at all, or is truncated. */
    | 'not-a-backup'
    /**
     * A §D envelope written by a *newer* build. Updating fixes it; the file is fine.
     *
     * <p>Split from the older case because the two remedies are opposites and only this one is
     * "update". A single message told someone holding an older file to update, which cannot work
     * and, if acted on, makes their position worse.</p>
     */
    | 'unsupported-version-newer'
    /** A §D envelope written by an *older* build, in a format this one no longer reads. */
    | 'unsupported-version-older'
    /**
     * The AEAD refused to open it.
     *
     * <p>Genuinely ambiguous, and must be reported as such: AES-GCM cannot distinguish a wrong key
     * from altered bytes, so this is *either* a wrong passphrase *or* a corrupted file.</p>
     */
    | 'wrong-passphrase-or-altered'
    /** The blob belongs to a different account than the one signed in. Refused, never merged. */
    | 'wrong-account'
    /** The header does not describe the contents - a re-labelled envelope. */
    | 'header-mismatch'
    /** The declared Argon2 parameters are above what this build will attempt (§L.9). */
    | 'hostile-kdf-parameters'
    /** The envelope opened but its contents are unusable. */
    | 'malformed-contents'
    /** The restore succeeded but the local stores could not be written. */
    | 'local-store-failed'
    /** Anything unrecognised. Never reported as a passphrase problem. */
    | 'engine-failed';

export class MlsBackupImportError extends Error {
    constructor(readonly reason: MlsBackupImportFailure, readonly detail: string) {
        super(detail);
    }
}

/**
 * Maps an engine rejection onto a remedy the user can act on.
 *
 * <p>An allow-list keyed on the engine's own wording, and it falls through to `engine-failed`
 * rather than to `wrong-passphrase-or-altered`. That direction is deliberate: telling someone their
 * passphrase is wrong when it is not is the failure this whole classification exists to prevent,
 * and an unrecognised error is by definition not evidence about their passphrase.</p>
 */
/**
 * The allow-list, in order. First phrase that appears in the engine's message wins.
 *
 * <p>A table rather than a ternary chain because the chain had grown to nine arms with mixed `||`
 * inside it, where one misplaced arm silently re-parses the whole rest of the expression - which is
 * a lot of load-bearing precedence to hold in your head for something whose entire job is to be
 * obviously right. The strings are produced by `import_backup` in `mls.rs`, and asserted on both
 * sides so the pairing cannot drift.</p>
 */
const IMPORT_FAILURE_PHRASES: readonly (readonly [string, MlsBackupImportFailure])[] = [
    ['not a backup file', 'not-a-backup'],
    ['is newer than this build supports', 'unsupported-version-newer'],
    ['is older than this build supports', 'unsupported-version-older'],
    // A cipher this build does not implement is the same situation as a newer format version,
    // and has the same remedy.
    ['unsupported backup cipher', 'unsupported-version-newer'],
    ['refusing declared Argon2 parameters', 'hostile-kdf-parameters'],
    ['different account', 'wrong-account'],
    ['header does not match', 'header-mismatch'],
    ['wrong passphrase', 'wrong-passphrase-or-altered'],
    ['backup has no', 'malformed-contents'],
    ['is unreadable', 'malformed-contents'],
    ['nonce is not 12 bytes', 'malformed-contents'],
];

function classifyBackupImport(err: unknown): MlsBackupImportError {
    const detail = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);

    const match = IMPORT_FAILURE_PHRASES.find(([phrase]) => detail.includes(phrase));
    return new MlsBackupImportError(match?.[1] ?? 'engine-failed', detail);
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
    /**
     * The user id the plaintext was authenticated as when it was decrypted.
     *
     * <p>Recorded so a cache hit can be re-checked against the author the server claims *this*
     * time. `senderMatchesClaimedAuthor` is the only binding between ciphertext and displayed
     * author on this client, and it runs on the decrypt path - which a cache hit skips entirely.
     * Without this, a hit is an unauthenticated render.</p>
     */
    author?: string;
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
    private readonly deviceIdentity = inject(DeviceIdentityService);
    private _cacheKey: Promise<CryptoKey> | null = null;

    // -------------------------------------------------------------------------
    // Per-account local stores
    //
    // Both files carry the device id, which is now one per account. They used to be
    // `mls-group-registry.json` and `mls-message-cache.json` flat - one pair for the whole
    // installation - so a second account signing in on the same machine read the first account's
    // context-to-group mappings and, because the cache seal key is per-device, could open the
    // first account's plaintext message history.
    //
    // Resolved lazily rather than in a field: the device id needs the active account slot, which
    // needs a store read, and a field initialiser cannot await.
    // -------------------------------------------------------------------------

    private readonly _stores = new Map<string, {registry: LazyStore; cache: LazyStore}>();

    private async storesForAccount(): Promise<{registry: LazyStore; cache: LazyStore}> {
        const deviceId = await this.deviceIdentity.deviceId();
        let pair = this._stores.get(deviceId);
        if (!pair) {
            pair = {
                registry: new LazyStore(`mls-group-registry-${deviceId}.json`),
                cache: new LazyStore(`mls-message-cache-${deviceId}.json`),
            };
            this._stores.set(deviceId, pair);
        }
        return pair;
    }

    private async registry(): Promise<LazyStore> {
        return (await this.storesForAccount()).registry;
    }

    private async cacheStore(): Promise<LazyStore> {
        return (await this.storesForAccount()).cache;
    }

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

    /**
     * Key under which the **high-water mark** lives: the highest generation this device has ever
     * held a group for in this context.
     *
     * Deliberately a different key from `#active`, and deliberately never deleted by any of the
     * paths that clear `#active`. See {@link getEncryptionFloor}.
     */
    private static encryptionFloorKey(contextId: string): string {
        return `${contextId}#floor`;
    }

    async registerGroup(contextId: string, generation: number, mlsGroupId: string): Promise<void> {
        await (await this.registry()).set(MlsService.groupKey(contextId, generation), mlsGroupId);
        await (await this.registry()).set(MlsService.activeGenerationKey(contextId), generation);
        await this.raiseEncryptionFloor(contextId, generation);
        await (await this.registry()).save();
    }

    // -------------------------------------------------------------------------
    // Encryption floor - monotonic, and the one thing the server cannot lower
    //
    // Encryption state arrived from the server and nothing local ever disagreed with it. A server
    // that answered `{encrypted: false}` for a context this device had been encrypting to got
    // `clearActiveGeneration` called, `getKnownGeneration` then returned null, and the very next
    // composed message went out as **plaintext** - into a conversation whose whole point was that
    // it could not. No group keys required, no MLS property broken; the client simply stopped
    // using them because it was asked to.
    //
    // The proof was already on disk. `clearActiveGeneration` keeps the `contextId#<generation>`
    // mapping on purpose - the old era's messages still need those keys - and nothing ever looked
    // at it. This is §L.6's monotonic floor applied to encryption state: the highest generation
    // ever seen, written once, never deleted, and consulted before anything is composed in the
    // clear.
    // -------------------------------------------------------------------------

    /**
     * The highest generation this device has ever held a group for, or null if never encrypted.
     *
     * <p>A non-null value means this context <b>was</b> encrypted here, whatever the server says
     * now. Cleartext composition must be refused above it.</p>
     */
    async getEncryptionFloor(contextId: string): Promise<number | null> {
        return (await (await this.registry()).get<number>(MlsService.encryptionFloorKey(contextId))) ?? null;
    }

    /** Raises the floor. Monotonic - a lower generation is ignored rather than written. */
    private async raiseEncryptionFloor(contextId: string, generation: number): Promise<void> {
        const current = await this.getEncryptionFloor(contextId);
        if (current !== null && current >= generation) return;
        await (await this.registry()).set(MlsService.encryptionFloorKey(contextId), generation);
    }

    /**
     * Lowers the floor, so this context may be composed in the clear again.
     *
     * <p><b>Only ever from an explicit, user-confirmed disable.</b> Nothing the server sends may
     * reach this: "the server says it is off now" is precisely the claim the floor exists to
     * refuse. The per-generation group mappings are kept, because the messages from the encrypted
     * era are still in the history and still need those keys.</p>
     */
    async clearEncryptionFloor(contextId: string): Promise<void> {
        await (await this.registry()).delete(MlsService.encryptionFloorKey(contextId));
        await (await this.registry()).save();
    }

    async getGroupId(contextId: string, generation: number): Promise<string | null> {
        return (await (await this.registry()).get<string>(MlsService.groupKey(contextId, generation))) ?? null;
    }

    /** The generation this device last saw as live for the context, if any. */
    async getKnownGeneration(contextId: string): Promise<number | null> {
        return (await (await this.registry()).get<number>(MlsService.activeGenerationKey(contextId))) ?? null;
    }

    /**
     * Records that a context is no longer encrypted, without forgetting the group that encrypted
     * it - the messages from that era are still in the history and still need its keys.
     */
    async clearActiveGeneration(contextId: string): Promise<void> {
        await (await this.registry()).delete(MlsService.activeGenerationKey(contextId));
        await (await this.registry()).save();
    }

    /** Group id for whichever generation this device believes is live. */
    async getActiveGroupId(contextId: string): Promise<string | null> {
        const generation = await this.getKnownGeneration(contextId);
        if (generation === null) return null;
        return this.getGroupId(contextId, generation);
    }

    async clearGroupRegistry(): Promise<void> {
        await (await this.registry()).clear();
        await (await this.registry()).save();
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

    /**
     * Cache key: context, generation and id together. **The same shape venta-mobile writes.**
     *
     * <p><b>`messageId` is chosen by the server.</b> Keyed on the id alone - which is what this
     * client did - a server that reuses an id it has already seen in another context gets this
     * device to render one thread's plaintext inside another, attributed to whoever the server
     * names. Nothing is decrypted on a cache hit, so no MLS property is broken and the only author
     * binding this client has (`senderMatchesClaimedAuthor`, on the decrypt path) is skipped
     * entirely. On the history path the lookup precedes group resolution, so the victim need not
     * even be a member of the context the id is replayed into.</p>
     *
     * <p>Byte-identical to mobile's `_cacheKey` on purpose, `'?'` placeholder included: the legacy
     * bare-id entries have to drain on both platforms in step, and a key shape that differs by one
     * character makes that impossible to reason about.</p>
     */
    private static cacheKey(contextId: string, generation: number | null, messageId: string): string {
        return `${contextId}#${generation ?? '?'}#${messageId}`;
    }

    /**
     * Records a decrypted plaintext.
     *
     * @param authorId the user id the decryptor authenticated. Stored, and re-checked on every hit.
     */
    async cacheMessage(
        contextId: string,
        generation: number | null,
        messageId: string,
        plaintextB64: string,
        authorId?: string,
    ): Promise<void> {
        const sealed = await this.seal(plaintextB64);
        await (await this.cacheStore()).set(
            MlsService.cacheKey(contextId, generation, messageId),
            {v: 1, at: Date.now(), ...sealed, author: authorId} satisfies CachedMessage,
        );
        // The bare-id entry this supersedes, if any. Dropped rather than left to age out: two keys
        // for one message is two copies of the plaintext, and the bare one is the exploitable one.
        await (await this.cacheStore()).delete(messageId);
        await this.pruneMessageCache();
        await (await this.cacheStore()).save();
    }

    /**
     * Plaintext for a message, or null.
     *
     * <p>A wrong `generation` or a wrong `contextId` is a **miss**, not a wrong answer, which is
     * the whole point of the composite key.</p>
     *
     * @param expectedAuthorId who the server says wrote it *this time*. A hit recorded under a
     *        different author is refused: the entry may be genuine and the claim about it is not.
     */
    async getCachedMessage(
        contextId: string,
        generation: number | null,
        messageId: string,
        expectedAuthorId?: string,
    ): Promise<string | null> {
        const key = MlsService.cacheKey(contextId, generation, messageId);
        const entry = await (await this.cacheStore()).get<CachedMessage | string>(key);
        if (entry) return this.openCacheEntry(entry, contextId, generation, messageId, expectedAuthorId);

        // Written before the key carried the context and generation. Read as a fallback, then
        // rewritten under the composite key, so the legacy shape drains away instead of being
        // carried forever - the same draining fallback mobile keeps, and it must be removed on
        // both platforms together or one of them loses history the other still has.
        const legacy = await (await this.cacheStore()).get<CachedMessage | string>(messageId);
        if (!legacy) return null;
        return this.openCacheEntry(legacy, contextId, generation, messageId, expectedAuthorId);
    }

    private async openCacheEntry(
        entry: CachedMessage | string,
        contextId: string,
        generation: number | null,
        messageId: string,
        expectedAuthorId?: string,
    ): Promise<string | null> {
        // Entries written before the cache was sealed are bare base64. Read once, rewritten sealed,
        // rather than discarded - they are the only copy of that message's plaintext.
        if (typeof entry === 'string') {
            await this.cacheMessage(contextId, generation, messageId, entry, expectedAuthorId);
            return entry;
        }

        // Refused rather than served. The stored author is the one the decryptor authenticated
        // against the MLS leaf; a differing claim now means the server is captioning one member's
        // words with another member's name, which is the same attack the decrypt path already
        // refuses. Entries with no recorded author predate this and cannot be checked.
        if (expectedAuthorId && entry.author && entry.author !== expectedAuthorId) return null;

        let plaintext: string;
        try {
            plaintext = await this.unseal(entry);
        } catch {
            // A cache entry we cannot open is no worse than a cache miss: the message renders as
            // undecryptable rather than as garbage.
            return null;
        }

        // Promote a legacy or author-less entry onto the composite key, now that the caller has
        // told us which context and generation it belongs to.
        const key = MlsService.cacheKey(contextId, generation, messageId);
        if (!(await (await this.cacheStore()).get(key)) || (!entry.author && expectedAuthorId)) {
            await this.cacheMessage(contextId, generation, messageId, plaintext, expectedAuthorId);
        }
        return plaintext;
    }

    /** Drops the plaintext cache. Part of every local-wipe path. */
    async clearMessageCache(): Promise<void> {
        await (await this.cacheStore()).clear();
        await (await this.cacheStore()).save();
    }

    private async pruneMessageCache(): Promise<void> {
        const entries = await (await this.cacheStore()).entries<CachedMessage | string>();
        if (entries.length <= MlsService.MESSAGE_CACHE_LIMIT) return;

        const aged = entries
            .map(([id, value]) => ({id, at: typeof value === 'string' ? 0 : value.at ?? 0}))
            .sort((a, b) => a.at - b.at);

        // Oldest first. Losing the oldest plaintext is the least bad outcome available: those
        // messages are the least likely to be scrolled back to, and the ratchet cannot recover any
        // of them either way.
        const excess = aged.slice(0, entries.length - MlsService.MESSAGE_CACHE_LIMIT);
        for (const {id} of excess) await (await this.cacheStore()).delete(id);
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
            // Empty is the honest answer when the engine has no buffer: nothing was held, so
            // nothing is waiting to be replayed. Catch-up carries on unaffected.
            this.callOptional<MlsReplayedMessage[]>(
                'mls_drain_pending_messages', {groupIdB64}, () => [],
            )
        );
    }

    // `verifySenderInRoster` and `processAndVerifyMessage` used to live here. Both are deleted
    // rather than wired up, because the guarantee their doc comments claimed - "guards against a
    // compromised server replaying a valid ciphertext with a spoofed credential" - was never real.
    //
    // openmls resolves a message's sender from a leaf in the ratchet tree and verifies the
    // signature against that leaf's key before `process_message` returns. Anything that comes back
    // has already been proved to originate from a current member, so asking afterwards whether the
    // sender is in the roster can only ever answer yes. It was a tautology wearing the label of a
    // security check, which is worse than no check: it made the missing one look present.
    //
    // The direction that genuinely is unauthenticated - the server's `authorId` field beside the
    // ciphertext, which the UI attributes the message to - is checked in
    // `MlsSyncService.senderMatchesClaimedAuthor`, on the one decrypt path every caller uses.

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
     * <p>The state file is named after this account's device id. Before it was, two accounts on
     * one machine shared one `mls_state.json`, and the engine's own defence - clearing everything
     * when the path changes - never fired, because the path never changed.</p>
     *
     * @returns `true` when state was restored from disk, `false` when starting fresh.
     */
    initStorage(): Observable<boolean> {
        // Both fetched here rather than passed in, so no caller can forget the key and quietly
        // leave the state file in the clear, or forget the scope and quietly share one file
        // between accounts.
        return from((async () => {
            const [stateKeyB64, scope, adoptLegacy] = await Promise.all([
                this.localStateKey(),
                this.deviceIdentity.deviceId(),
                this.deviceIdentity.ownsLegacyState(),
            ]);
            return this.call<boolean>('mls_init_storage', {stateKeyB64, scope, adoptLegacy});
        })());
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
            await (await this.registry()).entries<string | number>(),
        );

        const messageCache = includeMessageCache ? await this.readMessageCachePlain() : undefined;

        // Carried straight back out. Alpine mints no §H key, so this is only ever one a
        // venta-mobile envelope brought in - and omitting it is what made an Alpine re-export
        // destroy it. Undefined when this device holds none, which is the shape mobile's import
        // already tolerates.
        const identity = await this.readAccountIdentity(deviceId);
        const accountIdentity = identity ? {pub: identity.pub, priv: identity.priv} : undefined;

        // Distinguishable from a failure so the logout flow can offer to continue without a
        // backup instead of looping on a retry that cannot succeed.
        return this.callOptional<string>('mls_export_backup', {
            passphrase,
            userId,
            deviceId,
            appVersion,
            keyHandle,
            groupRegistry,
            messageCache,
            accountIdentity,
        }, () => { throw new MlsFeatureUnavailableError('mls_export_backup'); });
    }

    /**
     * Opens a backup envelope and applies it, then restores the registry and message cache locally.
     *
     * <p>The engine is restored only when the blob was taken on *this* device id - the discriminator
     * is the device id alone, enforced in Rust, and this side deliberately adds no second opinion
     * about it. On a new device the caller must re-register, replenish key packages, and get itself
     * re-admitted; §D allows the signing key, the registry and the cache across, and nothing
     * more.</p>
     *
     * <p><b>Ordered so a failure cannot half-apply.</b> Rust does every check and every decryption
     * before it mutates anything, and this method writes local stores only after it returns - with
     * the signing keypair first, because that is the one piece whose absence is unrecoverable and
     * the one piece the command used to drop.</p>
     *
     * @throws MlsBackupImportError with a `reason` the UI can render distinctly.
     */
    async importBackup(blob: string, passphrase: string, expectedUserId: string): Promise<MlsBackupImportResult> {
        const currentDeviceId = await this.deviceIdentity.deviceId();

        let result: MlsBackupImportResult;
        try {
            result = await this.callOptional<MlsBackupImportResult>('mls_import_backup', {
                blob,
                passphrase,
                expectedUserId,
                currentDeviceId,
            }, () => { throw new MlsFeatureUnavailableError('mls_import_backup'); });
        } catch (err) {
            if (err instanceof MlsFeatureUnavailableError) throw err;
            throw classifyBackupImport(err);
        }

        try {
            // First, and into the keychain rather than only into this session. `autoUnlock` reads
            // the pair from `alpine_mls_{deviceId}_*` on every cold start, so an import that set
            // only the session handle restored a device that worked until the app was next killed
            // and then looked exactly like lost keys - which is the one failure mode a restore
            // exists to end. It is also the only step here whose loss cannot be repaired by
            // running the import again.
            await firstValueFrom(this.persistSigningKey(currentDeviceId, {
                signingPublicKey: result.signingPublicKey,
                signingPrivateKey: result.signingPrivateKey,
                keyPackages: [],
                keyHandle: result.keyHandle,
            }, result.identity));

            // Beside the signing key, and for the same reason: it lives in the keychain, so an
            // import that only returned it would have restored nothing. Alpine mints no §H key of
            // its own, but a venta-mobile envelope carries one and this is the only chance to keep
            // it - the next Alpine export reads it back from here.
            await this.persistAccountIdentity(currentDeviceId, result);

            // Without the registry every context reads as unencrypted, whatever the engine holds.
            await this.mergeRestoredRegistry(result.groupRegistry);

            // Written back under whatever key the export carried. A backup taken before the
            // composite key existed holds bare ids, and those stay bare rather than being guessed
            // into a context they may not belong to - the draining fallback in `getCachedMessage`
            // picks them up the first time a caller does know the context, which is the only
            // moment that is knowable.
            for (const [key, plaintextB64] of Object.entries(result.messageCache)) {
                await this.writeSealedCacheEntry(key, plaintextB64);
            }
            await (await this.cacheStore()).save();
        } catch (err) {
            throw new MlsBackupImportError(
                'local-store-failed',
                `The backup opened, but this device could not save what it restored: `
                + `${err instanceof Error ? err.message : String(err)}`,
            );
        }

        this.keyHandle.set(result.keyHandle);
        return result;
    }

    /**
     * Stores the §H account identity keypair, when the envelope carried one.
     *
     * <p>Written only when both halves are present. A public key with no private half is not a
     * usable identity, and storing it would make the next export emit a broken `accountIdentity`
     * section where a *missing* one is what mobile's import correctly tolerates.</p>
     */
    private async persistAccountIdentity(
        deviceId: string,
        result: MlsBackupImportResult,
    ): Promise<void> {
        const pub = result.accountIdentityPublicKey;
        const priv = result.accountIdentityPrivateKey;
        if (!pub || !priv) return;

        await Promise.all([
            secureStorage.setItem(this.accountIdentityKey(deviceId, 'pub'), pub),
            secureStorage.setItem(this.accountIdentityKey(deviceId, 'priv'), priv),
        ]);
    }

    /** The §H keypair this device holds, or null. Both halves or neither. */
    private async readAccountIdentity(
        deviceId: string,
    ): Promise<{pub: string; priv: string} | null> {
        try {
            const [pub, priv] = await Promise.all([
                secureStorage.getItem(this.accountIdentityKey(deviceId, 'pub')),
                secureStorage.getItem(this.accountIdentityKey(deviceId, 'priv')),
            ]);
            return pub && priv ? {pub, priv} : null;
        } catch {
            // An unreadable keychain must not stop a backup being written. The §H key is the one
            // thing in the envelope this client cannot mint, but a backup missing it is still far
            // better than no backup - and this is the logout path, where the alternative to
            // writing one is destroying the keys outright.
            return null;
        }
    }

    private accountIdentityKey(deviceId: string, field: 'pub' | 'priv'): string {
        return `alpine_mls_${deviceId}_account_identity_${field}`;
    }

    /**
     * Merges a restored group registry into the live one, without letting it go backwards.
     *
     * <p><b>A plain write over these keys is a downgrade.</b> The registry is not a bag of values -
     * `#floor` is the monotonic encryption floor, written once and deliberately never deleted, and
     * it is the one thing standing between a context that was encrypted and a message composed
     * into it in the clear. Restoring an older backup with a straight `set()` per key - which is
     * what this did - lowered it, and the very next message went out as plaintext into a
     * conversation whose whole point was that it could not. No group keys required and no MLS
     * property broken; the client simply stopped using them because a file told it to.</p>
     *
     * <p>The three key shapes are merged on their own terms:</p>
     * <ul>
     *   <li>`ctx#N` -> group id: additive. Two eras of one context are different groups and both
     *       sets of messages still need their own keys, so nothing here is ever dropped.</li>
     *   <li>`ctx#floor`: raised, never lowered. {@link raiseEncryptionFloor} already enforces it.</li>
     *   <li>`ctx#active`: taken only when it is at or above the resulting floor. A restored
     *       "currently on generation 2" for a context this device has since encrypted at 5 is
     *       stale information about the present, not evidence about it.</li>
     * </ul>
     */
    private async mergeRestoredRegistry(
        restored: Record<string, string | number>,
    ): Promise<void> {
        const registry = await this.registry();

        // Two passes, because `#active` is judged against the floor and the floor may itself be
        // raised by this same backup. Doing it in one pass would have the outcome depend on the
        // iteration order of an object that came off the wire.
        for (const [key, value] of Object.entries(restored)) {
            if (!key.endsWith('#floor')) continue;
            const contextId = key.slice(0, -'#floor'.length);
            if (typeof value === 'number') await this.raiseEncryptionFloor(contextId, value);
        }

        for (const [key, value] of Object.entries(restored)) {
            if (key.endsWith('#floor')) continue;

            if (key.endsWith('#active')) {
                const contextId = key.slice(0, -'#active'.length);
                const floor = await this.getEncryptionFloor(contextId);
                if (typeof value !== 'number') continue;
                if (floor !== null && value < floor) continue;
                await registry.set(key, value);
                continue;
            }

            await registry.set(key, value);
        }

        await registry.save();
    }

    /** Seals `plaintextB64` under the exact key given, bypassing composite-key construction. */
    private async writeSealedCacheEntry(key: string, plaintextB64: string): Promise<void> {
        const sealed = await this.seal(plaintextB64);
        await (await this.cacheStore()).set(key, {v: 1, at: Date.now(), ...sealed} satisfies CachedMessage);
    }

    private async readMessageCachePlain(): Promise<Record<string, string>> {
        const entries = await (await this.cacheStore()).entries<CachedMessage | string>();
        const out: Record<string, string> = {};

        // Keyed by the *stored* key, composite or legacy-bare, so a restore reproduces the cache it
        // was taken from rather than collapsing every context's copy of one id onto each other.
        for (const [key, value] of entries) {
            if (typeof value === 'string') {
                out[key] = value;
                continue;
            }
            try {
                out[key] = await this.unseal(value);
            } catch {
                // An entry this device can no longer open is not worth exporting.
            }
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
     *
     * @param expectedUserId who is signed in. When given, a stored identity that names someone
     *        else is refused as `IdentityMismatch` rather than loaded. Per-account device ids
     *        should make that unreachable - this is the check that makes a bug in that scoping
     *        loud instead of silent, and silent is what it was: the stored identity has always
     *        been the user id, and nothing ever compared it to anything.
     */
    autoUnlock(deviceId: string, expectedUserId?: string): Observable<string> {
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
                // Deliberately its own kind. `KeyNotFound` routes to the registration modal, which
                // mints a fresh signing keypair and orphans this device from every group it
                // belongs to - an irreversible answer to a situation where the right key exists
                // and is simply not this account's.
                if (expectedUserId && identity !== expectedUserId) {
                    const err: MlsTypedError = {
                        kind: 'IdentityMismatch',
                        message: `The signing key stored for this device belongs to ${identity}, `
                            + `not to the signed-in account`,
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
                // The §H keypair goes with them. It is account key material like the rest, and
                // leaving it behind for whoever signs in next is the leak this teardown exists to
                // prevent - the more so because nothing else on this client ever mints one, so a
                // stale entry would be indistinguishable from a legitimately restored one.
                secureStorage.removeItem(this.accountIdentityKey(deviceId, 'pub')),
                secureStorage.removeItem(this.accountIdentityKey(deviceId, 'priv')),
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
     * Invokes a command the running build may not define.
     *
     * Three commands - `mls_drain_pending_messages`, `mls_export_backup`, `mls_import_backup` -
     * currently have a TypeScript caller and no Rust definition: this engine file was overwritten
     * with the other client's, and restoring Alpine's last-known-good version brought back a
     * surface that predates them. They return with the re-port from mobile, whose engine has all
     * three, so the callers stay put rather than being deleted and re-added.
     *
     * Until then an unresolved command must degrade rather than throw. A missing *feature* is not
     * the same event as a failing one, and the distinction matters most on the logout path, where
     * treating "unavailable" as "failed" traps the user retrying a command that can never succeed.
     *
     * @param onMissing the value to return when the command is not defined. A genuine failure from
     *        a command that *does* exist still rejects, and must.
     */
    private async callOptional<T>(
        command: string,
        args: Record<string, unknown> | undefined,
        onMissing: () => T,
    ): Promise<T> {
        requireTauri();
        try {
            return await invoke<T>(command, args);
        } catch (err) {
            if (isCommandNotFound(err, command)) return onMissing();
            throw err;
        }
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
