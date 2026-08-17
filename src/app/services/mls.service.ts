import {inject, Injectable, Injector, signal} from '@angular/core';
import {firstValueFrom, from, Observable} from 'rxjs';
import {map, switchMap} from 'rxjs/operators';
import {asMlsSessionTakeover} from '../platform/mls-session';
import {MlsEngine} from '../platform/ports/mls-engine.port';
import {MlsLocalStore, MlsLocalStoreFactory} from '../platform/ports/mls-local-store.port';
import {SecureStore} from '../platform/ports/secure-store.port';
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
    /** The stored signing key is another account's: never answered with `KeyNotFound`, which mints a fresh keypair and orphans this device from every group. */
    | 'IdentityMismatch'
    /** Signing entries partly present (an empty string counts): never `KeyNotFound`, because something stored means this device registered and re-registering orphans it. */
    | 'KeyStoreIncomplete'
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
    /** TLS-serialized KeyPackage (base64), uploaded to the server. */
    keyPackage: string;
    /** HPKE init private key (base64), stored encrypted under the master key. */
    initPrivateKey: string;
}

export interface MlsKeyPackageBatch {
    /** Ed25519 public key (base64) */
    signingPublicKey: string;
    /** Ed25519 private key (base64), stored encrypted under the master key. Pass to `loadSigningKey` per unlock, then discard; never to group operations directly. */
    signingPrivateKey: string;
    keyPackages: KeyPackageResult[];
    /** Opaque session handle: use it for all group operations this session, so the private key bytes never re-cross IPC. */
    keyHandle: string;
}

/** What a reviewer is shown before vouching for someone's admission. */
export interface MlsKeyPackageInfo {
    /** The user id this package claims, from its BasicCredential. */
    identity: string;
    /** Long-lived Ed25519 signature key (base64). */
    signaturePublicKey: string;
    /** Human-comparable fingerprint of the *signature* key, in five-character groups. Stable across every key package a device mints, which is what makes it comparable out of band. */
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

/** Result of `addMembers` / `removeMembers` / `leaveGroup`: `commit` goes to every existing member, `welcome` (when present) only to the newly added ones. */
export interface MlsCommitOut {
    /** Base64 TLS-serialized MlsMessage (commit) */
    commit: string;
    /** Base64 TLS-serialized MlsMessage (welcome), present when members were added */
    welcome: string | null;
    /** Group epoch after this commit was applied */
    epoch: number;
    /** GroupInfo for the epoch this commit *establishes*. Publish this, never {@link MlsService.exportGroupInfo}, whose export is one epoch stale until the commit merges. */
    groupInfo: string | null;
}

/** Result of `rejoinGroup`. The `externalCommit` must be broadcast to all existing group members. */
export interface MlsRejoinOut {
    groupInfo: MlsGroupInfo;
    /** Base64 TLS-serialized external commit, broadcast to all group members. */
    externalCommit: string;
}

/** Result of `processMessage`. Check `kind` first: `"application"` fills `plaintext`, `"commit"` advances group state and `epoch`, `"proposal"` queues a proposal that a commit must follow. */
export interface MlsProcessedMessage {
    /** `"buffered"`: from an epoch this device has not reached. Held, never dropped, because the wire copy decrypts exactly once; {@link MlsService.drainPendingMessages} returns it once the missing commits are applied. */
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
    /** The device the backup was taken on, not necessarily this one. */
    deviceId: string;
    createdAt: string;
    appVersion: string;
    identity: string;
    /** Session handle for the restored signing key, immediately usable. */
    keyHandle: string;
    /** The restored signing keypair, base64. Must be written to the OS keychain, not just this session: `autoUnlock` re-reads it on every cold start. */
    signingPublicKey: string;
    signingPrivateKey: string;
    /** False on a new device. Cloning ratchet state onto a second live device reuses sender-ratchet generations, which openmls treats as a replay, and voids forward secrecy for that leaf. */
    engineRestored: boolean;
    groupRegistry: Record<string, string | number>;
    messageCache: Record<string, string>;
    /** The account identity keypair (§H), when the envelope carried one. Alpine mints none, so these must be carried and stored or a re-export destroys a mobile backup's identity key. */
    accountIdentityPublicKey?: string | null;
    accountIdentityPrivateKey?: string | null;
}

/** Gate on {@link MlsEngine.available}, never on the host shell, and refuse synchronously at the call site so a caller that never subscribes cannot believe the work was queued. */
export class MlsUnavailableError extends Error {
    constructor() {
        super('MLS is unavailable: this build has no local MLS engine.');
    }
}

/** An MLS feature the UI has and this build's engine does not. Distinct from a failure: retrying a command the binary does not define never succeeds. */
export class MlsFeatureUnavailableError extends Error {
    constructor(readonly command: string) {
        super(`This build does not support ${command}.`);
    }
}

/** Whether the host refused to resolve the command, rather than the command failing. The command name must appear alongside the not-found wording, so a genuine "not found" engine error is never swallowed as an absent feature. */
function isCommandNotFound(err: unknown, command: string): boolean {
    const text = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
    return text.includes(command) && /not\s+found|unknown command|not\s+allowed/i.test(text);
}

/** The readable half of a rejection: both hosts reject with a bare string in places and an `Error` in others, and either alone prints nothing useful for the other. */
function describeCause(err: unknown): string {
    return typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// This device's signing identity, as it is spread across secure storage
// ---------------------------------------------------------------------------

/** The three entries `autoUnlock` needs, in the order it passes them to `mls_load_signing_key`. All three absent and some absent are different events with opposite responses. */
const SIGNING_FIELDS = ['pub', 'priv', 'identity'] as const;

type SigningField = typeof SIGNING_FIELDS[number];

/** What one signing entry turned out to be. Four states, and they must stay four: a `!value` test collapses absence, fault and empty string into the one answer that mints a fresh keypair. */
type SigningEntryRead =
    | {field: SigningField; state: 'present'; value: string}
    /** The store was read and reported no such entry. The only state that can license a mint. */
    | {field: SigningField; state: 'absent'}
    /** The entry exists and holds `''`. Present but broken, never absence: it cannot be a key under any encoding, and it never licenses replacing the entries beside it. */
    | {field: SigningField; state: 'empty'}
    /** The read did not happen. Says nothing at all about what is stored. */
    | {field: SigningField; state: 'faulted'; detail: string};

/** One settled read, named. A resolved `undefined` is a fault, never absence: {@link SecureStore.getItem} answers a string or `null`, so `undefined` is an adapter that did not read. */
function classifySigningEntry(
    field: SigningField,
    read: PromiseSettledResult<string | null>,
): SigningEntryRead {
    if (read.status === 'rejected') return {field, state: 'faulted', detail: describeCause(read.reason)};

    const value: string | null | undefined = read.value;
    if (value === undefined) {
        return {
            field,
            state: 'faulted',
            detail: 'the read resolved undefined, which SecureStore.getItem does not permit - so the '
                + 'store did not answer, rather than answering that nothing is there',
        };
    }
    if (value === null) return {field, state: 'absent'};
    return value === '' ? {field, state: 'empty'} : {field, state: 'present', value};
}

/** Narrowing filters, so the union above survives a `filter` call. */
function isFaulted(entry: SigningEntryRead): entry is SigningEntryRead & {state: 'faulted'} {
    return entry.state === 'faulted';
}

function isPresent(entry: SigningEntryRead): entry is SigningEntryRead & {state: 'present'} {
    return entry.state === 'present';
}

/** Why a §D backup could not be restored. Kept separate because the remedies are disjoint: collapsing them tells a user to doubt a passphrase that was correct. */
export type MlsBackupImportFailure =
    /** The file is not a §D envelope at all, or is truncated. */
    | 'not-a-backup'
    /** A §D envelope written by a *newer* build. Updating fixes it; the file is fine. Never merged with the older case, whose remedy is the opposite. */
    | 'unsupported-version-newer'
    /** A §D envelope written by an *older* build, in a format this one no longer reads. */
    | 'unsupported-version-older'
    /** The AEAD refused to open it. Must be reported as ambiguous: AES-GCM cannot tell a wrong key from altered bytes. */
    | 'wrong-passphrase-or-altered'
    /** The blob belongs to a different account than the one signed in. Refused, never merged. */
    | 'wrong-account'
    /** The header does not describe the contents: a re-labelled envelope. */
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
 * The allow-list, in order: the first phrase found in the engine's message wins, and an
 * unrecognised one falls through to `engine-failed`, never to `wrong-passphrase-or-altered`.
 * Phrases come from `import_backup` in `mls.rs` and are asserted on both sides.
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
    /** The user id the plaintext was authenticated as. A cache hit skips the decrypt path's `senderMatchesClaimedAuthor`, so without re-checking this a hit is an unauthenticated render. */
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

    public readonly keyHandle = signal<string | undefined>(undefined)

    private readonly _groupQueues = new Map<string, Promise<unknown>>();
    private readonly deviceIdentity = inject(DeviceIdentityService);
    private _cacheKey: Promise<CryptoKey> | null = null;

    /** The three ports below stay resolved on demand, never injected as fields: as fields they make constructing this service require all three providers, which breaks callers that never touch an engine. */
    private readonly injector = inject(Injector);

    /** IPC on the desktop, wasm-bindgen in a browser. The one thing every method here needs. */
    private get engine(): MlsEngine {
        return this.injector.get(MlsEngine);
    }

    /** The group registry and the plaintext message cache: `LazyStore` files, or IndexedDB. */
    private get localStores(): MlsLocalStoreFactory {
        return this.injector.get(MlsLocalStoreFactory);
    }

    /** The OS keychain on desktop, IndexedDB on web: holds the signing keypair, the §H identity keypair and the key the engine state and message cache are sealed under. */
    private get secureStore(): SecureStore {
        return this.injector.get(SecureStore);
    }

    // -------------------------------------------------------------------------
    // Per-account local stores
    //
    // Both file names must carry the device id, which is one per account: a flat name lets a
    // second account on the same machine read the first's group mappings and plaintext history.
    // Resolved lazily because the device id needs an awaited store read.
    // -------------------------------------------------------------------------

    private readonly _stores = new Map<string, {registry: MlsLocalStore; cache: MlsLocalStore}>();

    private async storesForAccount(): Promise<{registry: MlsLocalStore; cache: MlsLocalStore}> {
        const deviceId = await this.deviceIdentity.deviceId();
        let pair = this._stores.get(deviceId);
        if (!pair) {
            // Through the port rather than `new LazyStore(...)`, so a browser client has these two
            // files too. The names stay unchanged, so the desktop opens the same two files.
            pair = {
                registry: this.localStores.open(`mls-group-registry-${deviceId}.json`),
                cache: this.localStores.open(`mls-message-cache-${deviceId}.json`),
            };
            this._stores.set(deviceId, pair);
        }
        return pair;
    }

    private async registry(): Promise<MlsLocalStore> {
        return (await this.storesForAccount()).registry;
    }

    /**
     * A registry lookup that answers "nothing recorded" where there is no engine: a host with no
     * engine has provably recorded nothing, so `null` is the true answer, not a swallowed error.
     *
     * Reads only, never the writes beside them, and gated on {@link MlsEngine.available}, which is
     * false only once loading has failed and never while it is merely pending: a pending-counts-as-
     * unavailable read would answer "never encrypted" for a context this device encrypts (§L.9).
     */
    private async readRegistry<T>(key: string): Promise<T | null> {
        if (!this.engine.available) return null;
        return (await (await this.registry()).get<T>(key)) ?? null;
    }

    private async cacheStore(): Promise<MlsLocalStore> {
        return (await this.storesForAccount()).cache;
    }

    // -------------------------------------------------------------------------
    // Group registry: maps (contextId, generation) → MLS groupId (persisted)
    //
    // The generation must stay part of the key and old entries must never be dropped. Each
    // off/on stretch is a distinct group whose epochs restart at zero, so keying by context alone
    // decrypts the first era's messages against the second era's keys.
    // -------------------------------------------------------------------------

    private static groupKey(contextId: string, generation: number): string {
        return `${contextId}#${generation}`;
    }

    /** Key under which we remember which generation a context is currently on. */
    private static activeGenerationKey(contextId: string): string {
        return `${contextId}#active`;
    }

    /** High-water mark: the highest generation this device ever held a group for here. A separate key from `#active`, and never deleted by any path that clears `#active`. */
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
    // Encryption floor: monotonic, and the one thing the server cannot lower
    //
    // §L.6 applied to encryption state: the highest generation ever seen, written once, never
    // deleted, consulted before anything is composed in the clear. Without it a server answering
    // `{encrypted: false}` for a context this device encrypts sends the next message as plaintext.
    // -------------------------------------------------------------------------

    /** The highest generation this device ever held a group for, or null if never encrypted. Non-null means this context was encrypted here whatever the server says now, so cleartext must be refused above it. */
    async getEncryptionFloor(contextId: string): Promise<number | null> {
        return this.readRegistry<number>(MlsService.encryptionFloorKey(contextId));
    }

    /**
     * Raises the floor. Monotonic: a lower generation is ignored, never written.
     *
     * Must stay one {@link MlsLocalStore.update}, never a read then a write: two browser tabs both
     * read the same floor and the loser writes it backwards. Must not read through
     * {@link getEncryptionFloor} either, whose `null` on an unavailable engine would lower it.
     */
    private async raiseEncryptionFloor(contextId: string, generation: number): Promise<void> {
        await (await this.registry()).update<number>(
            MlsService.encryptionFloorKey(contextId),
            current => (current !== undefined && current >= generation ? current : generation),
        );
    }

    /** Lowers the floor so this context may be composed in the clear again. Only ever from an explicit user-confirmed disable: nothing the server sends may reach this. */
    async clearEncryptionFloor(contextId: string): Promise<void> {
        await (await this.registry()).delete(MlsService.encryptionFloorKey(contextId));
        await (await this.registry()).save();
    }

    async getGroupId(contextId: string, generation: number): Promise<string | null> {
        return this.readRegistry<string>(MlsService.groupKey(contextId, generation));
    }

    /** The generation this device last saw as live for the context, if any. */
    async getKnownGeneration(contextId: string): Promise<number | null> {
        return this.readRegistry<number>(MlsService.activeGenerationKey(contextId));
    }

    /** Records that a context is no longer encrypted, keeping the group that encrypted it: that era's messages are still in the history and still need its keys. */
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
    // Message cache: MLS ratchets forward only, so a message decrypts from the wire exactly once
    // and history is unreadable without this. It holds every plaintext this device has read, so it
    // stays sealed under the keychain-held state key and stays bounded.
    // -------------------------------------------------------------------------

    /** Entries kept before the oldest are dropped. Roughly a year of an active conversation. */
    private static readonly MESSAGE_CACHE_LIMIT = 5_000;

    /**
     * Cache key: context, generation and id together, byte-identical to venta-mobile's `_cacheKey`
     * including the `'?'` placeholder, so legacy bare-id entries drain on both platforms in step.
     *
     * Never key on `messageId` alone: the server chooses it, so a reused id replays one thread's
     * plaintext into another with no decrypt and no author check to stop it.
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
        // The superseded bare-id entry, dropped rather than aged out: the bare key is the
        // exploitable one, and two keys for one message is two copies of the plaintext.
        await (await this.cacheStore()).delete(messageId);
        await this.pruneMessageCache();
        await (await this.cacheStore()).save();
    }

    /**
     * Plaintext for a message, or null. A wrong `generation` or `contextId` is a miss, never a
     * wrong answer.
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

        // Legacy bare-id entries, read as a fallback and rewritten under the composite key so the
        // shape drains away. Mobile keeps the same fallback; remove it on both platforms together
        // or one of them loses history the other still has.
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
        // Entries written before the cache was sealed are bare base64. Read once and rewritten
        // sealed rather than discarded: they are the only copy of that message's plaintext.
        if (typeof entry === 'string') {
            await this.cacheMessage(contextId, generation, messageId, entry, expectedAuthorId);
            return entry;
        }

        // Refused, not served: the stored author was authenticated against the MLS leaf, so a
        // differing claim is the server captioning one member's words with another's name.
        // Entries with no recorded author predate this and cannot be checked.
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

        // Oldest first: least likely to be scrolled back to, and the ratchet cannot recover any of
        // them either way.
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

    /** The imported AES key, derived from {@link localStateKey} once per session. A rejection must never be memoised: a transient keychain fault at boot would leave every cached plaintext unreadable for the session. */
    private async cacheKey(): Promise<CryptoKey> {
        this._cacheKey ??= this.localStateKey()
            .then(raw =>
                crypto.subtle.importKey('raw', fromB64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']),
            )
            .catch((err: unknown) => {
                this._cacheKey = null;
                throw err;
            });
        return this._cacheKey;
    }

    /**
     * The 32-byte key the engine state and the message cache are both sealed under, held by
     * {@link SecureStore} and never written beside what it protects. Minted on first use.
     *
     * Minting is licensed by a successful read reporting absence and by nothing else, so nothing
     * here may catch: a failed read that mints hands the engine the wrong key, and the resulting
     * "state does not open" is on the corrupt list, so the launch wipes this device's group keys.
     */
    private async localStateKey(): Promise<string> {
        const deviceId = await this.deviceIdentity.deviceId();
        const name = `alpine_mls_${deviceId}_statekey`;

        // Read and mint must stay one `update`: as a `getItem` then a `setItem` two browser tabs
        // both read absence and mint different keys, and the loser's engine blob is sealed under a
        // key nothing will produce again, which the boot path answers by wiping the group state.
        const stored = await this.secureStore.update(
            name,
            // Typed wider than the port promises so the compiler keeps the case: `undefined` is a
            // half-faulted read, and the one falsy value that must not collapse into "absent".
            (existing: string | null | undefined) => {
                if (existing === undefined) {
                    // Phrased with no `MLS_STATE_UNREADABLE_MARKERS` marker, so it classifies as
                    // `unknown`: transient, no wipe.
                    throw new Error(
                        `SecureStore.getItem("${name}") resolved undefined. The port answers a string `
                        + `or null, so this is a store that could not read, not a device with no entry `
                        + `- and minting a fresh state key over an entry that may still be there is `
                        + `what makes a recoverable fault into permanent loss of this device's group `
                        + `keys.`,
                    );
                }
                // Absent, or an empty string: neither can be a 32-byte base64 key, so minting
                // overwrites nothing recoverable, and refusing would leave the device unlaunchable.
                if (existing !== null && existing !== '') return existing;
                return toB64(crypto.getRandomValues(new Uint8Array(32)));
            },
        );
        if (stored === null || stored === '') {
            // Unreachable: the callback mints for both. Asserted rather than cast, because the
            // alternative is handing the engine an empty sealing key.
            throw new Error(
                `SecureStore.update("${name}") resolved without a state key, so the MLS engine state `
                + `cannot be sealed. Nothing has been written over.`,
            );
        }
        return stored;
    }

    /** Loads a signing key into the Rust session store and returns an opaque handle. Call once per session unlock; the private key bytes never cross IPC again. */
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

    /** Removes a signing key from the Rust session store. Call on session lock or logout to clear key material from memory. */
    unloadSigningKey(keyHandle: string): Observable<void> {
        return from(this.call<void>('mls_unload_signing_key', {keyHandle}));
    }

    /**
     * A batch of fresh key packages for this identity, once per device registration. Store
     * `signingPrivateKey` and each `initPrivateKey` encrypted under the master key; upload each
     * `keyPackage` and `signingPublicKey`. The returned `keyHandle` is usable this session.
     */
    generateKeyPackages(identity: string, count: number): Observable<MlsKeyPackageBatch> {
        return from(this.call<MlsKeyPackageBatch>('generate_mls_key_packages', {identity, count}));
    }

    // -------------------------------------------------------------------------
    // Key package generation
    // -------------------------------------------------------------------------

    /**
     * More key packages under an existing signing key handle: unlike `generateKeyPackages` this
     * mints no new Ed25519 keypair, so it replenishes supply without rotating the signing key.
     *
     * @param keyHandle  Handle returned by `loadSigningKey` or `generateKeyPackages`.
     * @param count      Number of key packages to generate.
     */
    generateAdditionalKeyPackages(keyHandle: string, count: number): Observable<KeyPackageResult[]> {
        return from(this.call<KeyPackageResult[]>('mls_generate_key_packages_with_handle', {keyHandle, count}));
    }

    /**
     * Creates a new MLS group with a specific group ID.
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
     * Adds one or more members to an existing group.
     *
     * @param keyPackagesB64  List of base64 TLS-serialized KeyPackages from the
     *                        invitees' `generateKeyPackages` call.
     * @returns  `commit`, broadcast to all current members, and `welcome`, sent
     *           only to the newly added members.
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
     * Joins a group from a Welcome message received from an existing member.
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
     * Leaves the group. MLS forbids committing your own removal, so the `commit` field carries a
     * Remove *proposal*; publish it like a commit and a remaining member turns it into one via
     * {@link commitPendingProposals}. `epoch` is meaningless here and comes back as 0.
     *
     * Local group state is dropped immediately, so this device loses access whether or not anyone
     * ever commits the proposal.
     */
    leaveGroup(
        groupIdB64: string,
        keyHandle: string,
    ): Observable<MlsCommitOut> {
        return this.serialized(groupIdB64, () =>
            this.call<MlsCommitOut>('mls_leave_group', {groupIdB64, keyHandle})
        );
    }

    /** Commits every pending proposal, in practice the Remove a departing member left behind. Without it {@link leaveGroup} never completes and the group keeps encrypting to a member who erased their state. */
    commitPendingProposals(
        groupIdB64: string,
        keyHandle: string,
    ): Observable<MlsCommitOut> {
        return this.serialized(groupIdB64, () =>
            this.call<MlsCommitOut>('mls_commit_pending_proposals', {groupIdB64, keyHandle})
        );
    }

    /** This device's identity fingerprint, for reading out to whoever reviews its admission. Free to call: deriving it from a fresh key package would drain the single-use supply. */
    ownFingerprint(keyHandle: string): Observable<string> {
        return from(this.call<string>('mls_signing_key_fingerprint', {keyHandle}));
    }

    /** Inspects a key package before vouching for it or adding it. Validated, not merely parsed: a reviewer must never be shown an identity lifted from something add time would refuse. */
    inspectKeyPackage(keyPackageB64: string): Observable<MlsKeyPackageInfo> {
        return from(this.call<MlsKeyPackageInfo>('mls_inspect_key_package', {keyPackageB64}));
    }

    /**
     * Applies a commit staged by {@link addMembers} / {@link removeMembers} /
     * {@link commitPendingProposals}, only once the server has accepted it. Safe to retry: merging
     * with nothing staged is a no-op.
     *
     * @returns the group's epoch after the merge.
     */
    mergePendingCommit(groupIdB64: string): Observable<number> {
        return this.serialized(groupIdB64, () =>
            this.call<number>('mls_merge_pending_commit', {groupIdB64})
        );
    }

    /** Discards a staged commit the server refused: the losing side of a concurrent-commit race. Applying a commit the server did not take forks this device off the group permanently. */
    clearPendingCommit(groupIdB64: string): Observable<void> {
        return this.serialized(groupIdB64, () =>
            this.call<void>('mls_clear_pending_commit', {groupIdB64})
        );
    }

    /** A TLS-serialized GroupInfo blob for external commit or offline recovery, published so members who missed commits can re-sync. */
    exportGroupInfo(
        groupIdB64: string,
        keyHandle: string,
    ): Observable<string> {
        return from(this.call<string>('mls_export_group_info', {groupIdB64, keyHandle}));
    }

    /**
     * Re-joins a group via external commit after missing commits while offline.
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

    /** Permanently deletes a group from the local store, after a removal, after `leaveGroup`, or for GDPR erasure. */
    deleteGroup(groupIdB64: string): Observable<void> {
        // Serialized like every other mutation: deleting outside the queue tears the group out from
        // under an in-flight decrypt or staged commit, which reads as corruption.
        return this.serialized(groupIdB64, () =>
            this.call<void>('mls_delete_group', {groupIdB64}),
        ).pipe(map(() => {
            // Dropped only after the delete lands, so a queued operation behind it still runs
            // against the same chain rather than jumping ahead of it.
            this._groupQueues.delete(groupIdB64);
        }));
    }

    /**
     * Encrypts an application message for the group.
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
     * Processes an incoming MLS message (application data, commit, or proposal). Commits merge
     * immediately and advance group state; proposals are queued until any member commits.
     * A message from a future epoch answers `WrongEpoch`: buffer it and retry once the missing
     * commits have been fetched above our own epoch and applied in order.
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

    /** Messages that arrived before the commit that made them readable. Call after a catch-up applied commits: a message decrypts from the wire exactly once, so anything unheld was lost outright. */
    drainPendingMessages(groupIdB64: string): Observable<MlsReplayedMessage[]> {
        return this.serialized(groupIdB64, () =>
            // Empty is the honest answer when the engine has no buffer: nothing was held, so
            // nothing is waiting to be replayed.
            this.callOptional<MlsReplayedMessage[]>(
                'mls_drain_pending_messages', {groupIdB64}, () => [],
            )
        );
    }

    // Do not re-add a post-hoc roster check: openmls verifies the sender's leaf signature before
    // `process_message` returns, so it can only ever answer yes. The genuinely unauthenticated
    // direction is the server's `authorId`, checked in `MlsSyncService.senderMatchesClaimedAuthor`.

    /**
     * Removes members from the group by leaf index.
     *
     * @param leafIndices  Leaf indices of the members to remove (from `MlsMemberInfo.leafIndex`).
     * @returns  `commit`, broadcast to all remaining members.
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
     * Initializes the MLS storage layer and restores any previously persisted state. Call once on
     * app startup, before any group operation.
     *
     * The state file, and on web the IndexedDB blob, is named after this account's device id:
     * `scope` is the only thing keeping two accounts on one machine or browser profile from
     * reading each other's engine state.
     *
     * @returns `true` when state was restored, `false` when starting fresh.
     */
    initStorage(): Observable<boolean> {
        // Both fetched here rather than passed in, so no caller can forget the key and leave the
        // state file in the clear, or forget the scope and share one file between accounts.
        return from((async () => {
            const [stateKeyB64, scope, adoptLegacy] = await Promise.all([
                this.localStateKey(),
                this.deviceIdentity.deviceId(),
                this.deviceIdentity.ownsLegacyState(),
            ]);
            return this.call<boolean>('mls_init_storage', {stateKeyB64, scope, adoptLegacy});
        })());
    }

    /**
     * Emits when this tab is handed an account's engine another tab was holding, so whoever owns
     * the launch sequence can run it again. A tab that booted without the scope unlocked nothing.
     *
     * Never emits on the desktop: an adapter that cannot report a takeover completes without
     * emitting. The engine is resolved on subscribe, never in a field.
     */
    sessionTakeovers(): Observable<void> {
        return new Observable<void>(subscriber => {
            const takeover = asMlsSessionTakeover(this.engine);
            if (takeover === null) {
                subscriber.complete();
                return undefined;
            }
            return takeover.onSessionTakeover(() => subscriber.next());
        });
    }

    // -------------------------------------------------------------------------
    // Persistence
    // -------------------------------------------------------------------------

    /**
     * Deletes the persisted MLS state file and resets all in-memory group state, to recover from a
     * corrupted `mls_state.json`. Signing key handles survive; the group registry must be cleared
     * separately if needed.
     */
    clearStorage(): Observable<void> {
        return from(this.call<void>('mls_clear_storage'));
    }

    /** The full MLS state as an AES-256-GCM encrypted blob for cloud backup. `encryptionKeyB64` is a base64 32-byte key; `importState` restores it on a new device. */
    exportState(encryptionKeyB64: string): Observable<string> {
        return from(this.call<string>('mls_export_state', {encryptionKeyB64}));
    }

    /** Restores MLS state from an `exportState` blob, clearing current group state. Call `loadSigningKey` or `autoUnlock` separately to re-establish the signing key handle. */
    importState(encryptedB64: string, encryptionKeyB64: string): Observable<void> {
        return from(this.call<void>('mls_import_state', {encryptedB64, encryptionKeyB64}));
    }

    // -------------------------------------------------------------------------
    // Key backup (contract §D)
    //
    // `exportState` covers the openmls provider store alone and restores nothing on its own: it
    // omits the signing keypair, the device id, the group registry and the message cache. These two
    // assemble and open the full envelope Rust-side, because the signing key never crosses IPC.
    // -------------------------------------------------------------------------

    /**
     * Seals everything needed to restore this device into one passphrase-protected envelope.
     *
     * @param includeMessageCache plaintext message history. Excluded from the cloud target by
     *        default: the most sensitive thing in the envelope, so the choice is made explicitly.
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

        // Carried straight back out: Alpine mints no §H key, so omitting it makes a re-export
        // destroy the one a venta-mobile envelope brought in. Undefined when this device holds
        // none, which is the shape mobile's import tolerates.
        const identity = await this.readAccountIdentity(deviceId);
        const accountIdentity = identity ? {pub: identity.pub, priv: identity.priv} : undefined;

        // Distinguishable from a failure, so the logout flow can offer to continue without a
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
     * The device id alone decides what a restore recovers: the engine is restored only when the
     * blob was taken on *this* device id, enforced in Rust and never second-guessed here. On a new
     * device §D carries the signing key, the registry and the cache across and nothing more.
     *
     * Ordered so a failure cannot half-apply: Rust checks and decrypts everything before mutating,
     * local stores are written only after it returns, signing keypair first because its absence is
     * the one unrecoverable loss.
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
            // First, and into the keychain rather than only into this session: `autoUnlock` reads
            // the pair from `alpine_mls_{deviceId}_*` on every cold start, so a session-only
            // restore looks like lost keys after the next kill. The only step no re-run repairs.
            await firstValueFrom(this.persistSigningKey(currentDeviceId, {
                signingPublicKey: result.signingPublicKey,
                signingPrivateKey: result.signingPrivateKey,
                keyPackages: [],
                keyHandle: result.keyHandle,
            }, result.identity));

            // Beside the signing key and for the same reason: it lives in the keychain, and a
            // venta-mobile envelope's §H key is only kept if it is written here, since the next
            // Alpine export reads it back from this store.
            await this.persistAccountIdentity(currentDeviceId, result);

            // Without the registry every context reads as unencrypted, whatever the engine holds.
            await this.mergeRestoredRegistry(result.groupRegistry);

            // Written back under whatever key the export carried. Pre-composite backups hold bare
            // ids, and those stay bare rather than being guessed into a context they may not
            // belong to; `getCachedMessage`'s draining fallback picks them up when one is known.
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

    /** Stores the §H account identity keypair when the envelope carried one. Written only when both halves are present: a half pair makes the next export emit a broken `accountIdentity` section. */
    private async persistAccountIdentity(
        deviceId: string,
        result: MlsBackupImportResult,
    ): Promise<void> {
        const pub = result.accountIdentityPublicKey;
        const priv = result.accountIdentityPrivateKey;
        if (!pub || !priv) return;

        await Promise.all([
            this.secureStore.setItem(this.accountIdentityKey(deviceId, 'pub'), pub),
            this.secureStore.setItem(this.accountIdentityKey(deviceId, 'priv'), priv),
        ]);
    }

    /** The §H keypair this device holds, or null. Both halves or neither. */
    private async readAccountIdentity(
        deviceId: string,
    ): Promise<{pub: string; priv: string} | null> {
        try {
            const [pub, priv] = await Promise.all([
                this.secureStore.getItem(this.accountIdentityKey(deviceId, 'pub')),
                this.secureStore.getItem(this.accountIdentityKey(deviceId, 'priv')),
            ]);
            return pub && priv ? {pub, priv} : null;
        } catch {
            // An unreadable keychain must not stop a backup being written: this is the logout
            // path, where the alternative to a backup missing the §H key is destroying the keys.
            return null;
        }
    }

    private accountIdentityKey(deviceId: string, field: 'pub' | 'priv'): string {
        return `alpine_mls_${deviceId}_account_identity_${field}`;
    }

    /**
     * Merges a restored group registry into the live one, without letting it go backwards. A plain
     * `set()` per key is a downgrade: it lowers `#floor` and the next message goes out in the clear.
     *
     * - `ctx#N` -> group id: additive, nothing is ever dropped; each era needs its own keys.
     * - `ctx#floor`: raised, never lowered, via {@link raiseEncryptionFloor}.
     * - `ctx#active`: taken only when at or above the resulting floor.
     */
    private async mergeRestoredRegistry(
        restored: Record<string, string | number>,
    ): Promise<void> {
        const registry = await this.registry();

        // Two passes: `#active` is judged against a floor this same backup may raise, so one pass
        // would make the outcome depend on the iteration order of an object off the wire.
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
        // was taken from rather than collapsing every context's copy of one id together.
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

    /** Stores a freshly generated batch's signing key in the OS keychain, once after `generateKeyPackages` on first registration. Later launches use `autoUnlock`. */
    persistSigningKey(
        deviceId: string,
        batch: MlsKeyPackageBatch,
        identity: string,
    ): Observable<void> {
        return from(
            Promise.all([
                this.secureStore.setItem(this.secureKey(deviceId, 'pub'), batch.signingPublicKey),
                this.secureStore.setItem(this.secureKey(deviceId, 'priv'), batch.signingPrivateKey),
                this.secureStore.setItem(this.secureKey(deviceId, 'identity'), identity),
            ]).then(() => undefined),
        );
    }

    // -------------------------------------------------------------------------
    // Secure key storage (OS keychain / Credential Manager)
    // -------------------------------------------------------------------------

    /**
     * Loads the signing key from the OS keychain and returns a ready-to-use handle, on every app
     * launch. Throws `MlsTypedError { kind: 'KeyNotFound' }` when no key has been stored yet.
     *
     * Only three positive absences may answer `KeyNotFound`, because it routes to the registration
     * modal, which mints a fresh keypair over these entries and orphans this device from every
     * group it is in. Any faulted read, and any resolved `undefined`, is `MlsError`; a partial or
     * empty-string set is `KeyStoreIncomplete`, which is evidence the device *did* register.
     *
     * Known limitation: a reset credential store reports a true absence for a registered device,
     * so registering there still orphans it silently. Closing that needs a restore-first flow.
     *
     * @param expectedUserId who is signed in. A stored identity naming anyone else is refused as
     *        `IdentityMismatch` rather than loaded, so a bug in per-account device-id scoping is
     *        loud instead of silent.
     */
    autoUnlock(deviceId: string, expectedUserId?: string): Observable<string> {
        return from(this.readSigningEntries(deviceId)).pipe(
            switchMap(([pub, priv, identity]) => {
                // Its own kind, never `KeyNotFound`: the right key exists and is simply not this
                // account's, and the registration modal's answer to that is irreversible.
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
     * The three signing-key entries, or the typed refusal that says why they cannot be used. It
     * must never report "nothing is stored" for anything but three positive absences.
     *
     * `allSettled`, never `all`: `all` discards the other two reads on the first fault, which is
     * exactly what separates "the store is unavailable" from "this device holds part of a key".
     * Nothing here catches to fall through, so an unreadable store never becomes an answer.
     */
    private async readSigningEntries(deviceId: string): Promise<[string, string, string]> {
        const reads = await Promise.allSettled(
            SIGNING_FIELDS.map(field => this.secureStore.getItem(this.secureKey(deviceId, field))),
        );
        const entries = SIGNING_FIELDS.map((field, i) => classifySigningEntry(field, reads[i]!));

        // A fault dominates every other reading: a store that could not answer for one entry has
        // said nothing trustworthy about the other two either.
        const faulted = entries.filter(isFaulted);
        if (faulted.length > 0) {
            const err: MlsTypedError = {
                kind: 'MlsError',
                message: 'Secure storage is unavailable: '
                    + faulted.map(entry => `${entry.field}: ${entry.detail}`).join('; '),
            };
            throw err;
        }

        // Three positive absences: a fresh device, and the only licence to register. The best
        // evidence available locally, not proof; see the caveat in `autoUnlock`'s doc comment.
        if (entries.every(entry => entry.state === 'absent')) {
            const err: MlsTypedError = {
                kind: 'KeyNotFound',
                message: 'No signing key in secure storage -device not registered',
            };
            throw err;
        }

        const present = entries.filter(isPresent);
        if (present.length < entries.length) {
            const err: MlsTypedError = {
                kind: 'KeyStoreIncomplete',
                message: 'This device\'s signing key is only partly in secure storage ('
                    + entries.map(entry => `${entry.field}: ${entry.state}`).join(', ')
                    + '). Something is stored, so this device has registered - registering again '
                    + 'would mint a fresh keypair over it and orphan this device from every group it '
                    + 'belongs to, so it is deliberately not offered.',
            };
            throw err;
        }

        // Every entry is present by here and `filter` preserves order, so this is
        // `[pub, priv, identity]`, the order `mls_load_signing_key` takes them in.
        return present.map(entry => entry.value) as [string, string, string];
    }

    /** Removes the stored signing key from the OS keychain, on logout, account deletion or device de-registration. */
    clearStoredSigningKey(deviceId: string): Observable<void> {
        return from(
            Promise.all([
                this.secureStore.removeItem(this.secureKey(deviceId, 'pub')),
                this.secureStore.removeItem(this.secureKey(deviceId, 'priv')),
                this.secureStore.removeItem(this.secureKey(deviceId, 'identity')),
                // The §H keypair goes with them: it is account key material, and leaving it for
                // whoever signs in next is the leak this teardown exists to prevent.
                this.secureStore.removeItem(this.accountIdentityKey(deviceId, 'pub')),
                this.secureStore.removeItem(this.accountIdentityKey(deviceId, 'priv')),
            ]).then(() => undefined),
        );
    }

    /** @deprecated Prefer `DeviceIdentityService.deviceId()`. Kept so MLS call sites keep reading the one identifier rather than growing a second. */
    getOrCreateDeviceIdentifier(): Promise<string> {
        return this.deviceIdentity.deviceId();
    }

    deleteDeviceIdentifier(): Promise<void> {
        return this.deviceIdentity.reset();
    }

    /** Refuses when this host has no working engine. Thrown synchronously at the call site, never folded into the Observable, so an unsubscribed caller cannot believe the work was queued. */
    private requireEngine(): void {
        if (!this.engine.available) throw new MlsUnavailableError();
    }

    /**
     * Every call into the Rust engine goes through here, so a new command cannot forget the
     * availability guard. Fails closed: reporting success for an operation that never happened is
     * worse than refusing it. Command name and args pass through untouched, identical on both
     * hosts, which is what lets the Rust tests assert this file's call sites.
     */
    private call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        this.requireEngine();
        return this.engine.call<T>(command, args);
    }

    /**
     * Invokes a command the running build may not define: `mls_drain_pending_messages`,
     * `mls_export_backup` and `mls_import_backup` have TypeScript callers and no Rust definition
     * until the re-port from mobile lands. An unresolved command must degrade, never throw, or the
     * logout path traps the user retrying a command that can never succeed.
     *
     * @param onMissing the value to return when the command is not defined. A genuine failure from
     *        a command that *does* exist still rejects, and must.
     */
    private async callOptional<T>(
        command: string,
        args: Record<string, unknown> | undefined,
        onMissing: () => T,
    ): Promise<T> {
        this.requireEngine();
        try {
            return await this.engine.call<T>(command, args);
        } catch (err) {
            if (isCommandNotFound(err, command)) return onMissing();
            throw err;
        }
    }

    /** Serializes `op` behind any in-flight operation for `groupId`. The queue continues even when a prior operation rejects. */
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
