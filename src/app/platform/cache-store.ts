import {Injectable} from '@angular/core';

import {CacheSealService} from '../services/cache/cache-seal.service';
import {IdbStore, IdbStoreClosedError, openStore} from './web/idb';
import {criticalSectionName, detectLockManager, withWebLock} from './web/session-lock';

const DB_NAME = 'alpine-cache';
const STORE_NAME = 'entries';

/** Separates device, domain and key. None of the three contains it. */
const SEPARATOR = '::';

/**
 * Prefix of the per-device revision marker, kept in the same object store as the index it describes.
 *
 * <p>Outside every scope that is ever enumerated: {@link CacheStore.all} filters on
 * `${deviceId}::${domain}::` and {@link CacheStore.clear} walks the index's own keys, so the marker
 * is neither listed as an entry nor deleted by a wipe. Nothing can collide with it from the other
 * side either - an entry key could only begin `__rev::` if a device id did, and those are slot ids.
 * </p>
 */
const REVISION_PREFIX = `__rev${SEPARATOR}`;

/** The subsystem name this store takes its cross-tab locks under. */
const LOCK_AREA = 'cache-store';

export type CacheDomain = 'profile' | 'message';

/**
 * The ceiling each domain is held to, in bytes.
 *
 * <p><b>A hard per-domain ceiling, not a floor with borrowing.</b> {@link CacheStore.evict} compares
 * one domain's own total against its own number and drops that domain's least recently used entries
 * until it fits; it never looks at the other domain, in either direction. So a domain cannot grow
 * into headroom the other is not using, and equally cannot be pushed below its number by one that
 * is - which is the property that matters. Profiles are tiny and are the thing whose absence is
 * visible on screen, so a chatty channel must never be able to evict them, and a hard ceiling is
 * the simplest arrangement in which it cannot.</p>
 */
export const DOMAIN_RESERVES: Record<CacheDomain, number> = {
    profile: 5 * 1024 * 1024,
    message: 15 * 1024 * 1024,
};

/**
 * How long index writes are batched for, in milliseconds.
 *
 * <p>See the class comment's section on batching. Short enough that an abrupt close loses at most
 * this much of one generation of `lastAccess` bumps, long enough that a hydration-driven burst of
 * writes costs a handful of index writes rather than one per entry.</p>
 */
const INDEX_WRITE_WINDOW_MS = 200;

interface IndexEntry {
    bytes: number;
    lastAccess: number;
    domain: CacheDomain;
}

/**
 * A sealed, byte-budgeted cache over IndexedDB.
 *
 * <h3>The index is separate from the payloads, and that is the whole design</h3>
 *
 * <p>`MlsService.pruneMessageCache` decides an eviction by calling `entries()` - reading every
 * payload it holds - on every write. At five thousand small entries that is tolerable. At twenty
 * megabytes it would mean deserialising and decrypting the entire cache to drop one key, on the
 * path that renders a conversation.</p>
 *
 * <p>So sizes and access times live in one index entry, and eviction reads only that. A payload is
 * touched when it is asked for and at no other time.</p>
 *
 * <h3>`get()` does not persist the index, and `set()` batches it</h3>
 *
 * <p>The obvious design bumps `lastAccess` and writes the whole index back on every read. Profile
 * hydration reads every cached entry on startup, so that turns a cold start into N serialised
 * IndexedDB writes of the entire index - exactly the cost the separate-index design exists to avoid.
 * Instead `get()` only updates the in-memory index entry.</p>
 *
 * <p><b>The same argument applies to `set()`, and that was missed.</b> An index entry is around 110
 * bytes, so two thousand cached profiles is a ~220 KB index - and `ProfileCacheService.revalidateAll`
 * calls `set()` once per hydrated profile, on the main thread, just after launch. Re-sealing and
 * rewriting the whole index per call is two thousand AES encryptions and two thousand 220 KB writes
 * for one round of revalidation. So an index write is now <b>batched</b>: the first change after a
 * quiet period is written through immediately, and anything within {@link INDEX_WRITE_WINDOW_MS} of
 * that write joins one flush at the end of the window.</p>
 *
 * <p>What a batch can lose to an abrupt close is one window of `lastAccess` bumps and one index
 * generation. The payload rows are already written and the index self-heals on the next write, so
 * the cost is a slightly staler eviction victim and, at worst, an entry that reads as absent and is
 * refetched. <b>`delete()` and `clear()` are deliberately never batched</b>: an entry the user asked
 * to be gone that came back after a reload is not a degraded cache, it is a privacy defect.</p>
 *
 * <h3>Two tabs, one account</h3>
 *
 * <p>The whole index lives in one row, so it is a read-modify-write on a single key - the shape
 * `mls-local-store.web.ts` documents at length, and the reason that file's protocol is adopted here
 * wholesale rather than re-invented. Without it: tab A caches forty profiles, tab B starts up, and
 * B's first write serialises <i>its</i> in-memory index - which never held A's forty - over the
 * stored one. The forty payload rows are then listed by nothing. They are invisible to
 * {@link sizeOf}, so they are never evicted; invisible to {@link clear}, so <b>they survive a
 * sign-out wipe</b>; and invisible to {@link all}, so they are not even serving the user in exchange.
 * </p>
 *
 * <p>So, exactly as the MLS stores do:</p>
 * <ul>
 *   <li>Every index write bumps a per-device revision marker to a token unique to this tab and this
 *       write. It is compared, never ordered, so there is no clock and no shared counter.</li>
 *   <li>{@link sync} reloads the index when the stored marker differs from the one the in-memory
 *       copy was built at - one small get in the common case.</li>
 *   <li>An exclusive Web Lock, named for the device id, is held across the whole
 *       revalidate-write-bump sequence. Without it two tabs can each end up believing their copy
 *       matches the stored marker while one is missing the other's write, because the marker records
 *       only who wrote last.</li>
 *   <li>A reload re-applies whatever this tab has changed but not yet flushed. Batching and
 *       revalidation are otherwise in direct conflict: another tab's write landing between two of
 *       this tab's batched `set()`s would drop them from the index while their payload rows stayed
 *       on disk, which is the same orphaning by a different route.</li>
 * </ul>
 *
 * <p><b>Never nest these locks.</b> Every public method takes it exactly once and no private helper
 * below takes any; a nested request on one name queues behind its own holder forever.</p>
 *
 * <h3>One implementation for both hosts</h3>
 *
 * <p>Unlike the MLS stores, this has no on-disk history to stay compatible with and nothing here is
 * durable by contract - it is a cache, and losing it costs a refetch. So the desktop uses the same
 * IndexedDB as the browser rather than `LazyStore`, and there is no port, no factory pair and no
 * second adapter to keep in step. It imports no native module, so the platform boundary is intact.
 * </p>
 */
export class CacheStore {
    private store: Promise<IdbStore> | undefined;
    private index: Map<string, IndexEntry> | undefined;
    private readonly sizes: Record<CacheDomain, number> = {profile: 0, message: 0};

    /** The revision marker {@link index} was built at. `undefined` is a cache nothing has written. */
    private indexRevision: string | undefined;

    /**
     * False when the stored index was present and would not open, so the copy in memory is a guess.
     *
     * <p>Not the same as an empty cache. With no sealing key yet - the launch order this cache now
     * runs in - the index unseals to nothing, and memoising that would make the next write publish a
     * one-entry index over the real one and orphan every row it listed.</p>
     */
    private indexReadable = false;

    /** Index changes not yet flushed: the entry to write, or null for one that was removed. */
    private readonly pending = new Map<string, IndexEntry | null>();

    /** The pending batched flush, if one is scheduled. */
    private flushTimer: ReturnType<typeof setTimeout> | undefined;

    /** When the index was last written, so the first change after a quiet period goes straight out. */
    private lastIndexWrite = 0;

    /** Distinguishes this tab's index writes from every other tab's. Compared, never ordered. */
    private readonly writer = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    private writes = 0;

    private readonly lockName: string;

    /**
     * @param indexWriteWindowMs how long index writes are batched for. Injectable so a spec can
     *     prove the batching without waiting on a clock, and prove the unbatched paths at zero.
     * @param locks the profile's lock manager. Injectable because jsdom has none, and because two
     *     "tabs" in one spec have to share one manager for the guarantee above to be provable.
     */
    constructor(
        private readonly deviceId: string,
        private readonly seal: CacheSealService,
        private readonly openDb: () => Promise<IdbStore> = () => openStore(DB_NAME, STORE_NAME),
        private readonly indexWriteWindowMs: number = INDEX_WRITE_WINDOW_MS,
        private readonly locks: LockManager | undefined = detectLockManager(),
    ) {
        this.lockName = criticalSectionName(LOCK_AREA, deviceId);
    }

    /** Bytes currently held for one domain. Read from the index; touches no payload. */
    sizeOf(domain: CacheDomain): number {
        return this.sizes[domain];
    }

    async get<T>(domain: CacheDomain, key: string): Promise<T | undefined> {
        return await this.locked(async () => {
            const index = await this.sync();
            const scoped = this.scoped(domain, key);
            const entry = index.get(scoped);
            if (!entry) return undefined;

            const raw = await this.withStore(s => s.get(scoped));
            const value = typeof raw === 'string' ? await this.seal.unseal<T>(raw) : null;
            if (value === null) {
                // The payload is missing, or is sealed under something this key will not open.
                // Either way the entry can never be served again - and left in the index it would
                // keep charging its bytes against the domain's ceiling for the life of the cache,
                // evicting entries that are actually readable to make room for one that is not.
                await this.discard(index, scoped);
                await this.touchIndex(index);
                return undefined;
            }

            // In-memory only - see the class comment on why this does not flush the index.
            entry.lastAccess = Date.now();
            return value;
        });
    }

    async set(domain: CacheDomain, key: string, value: unknown): Promise<void> {
        // Sealed outside the lock: it touches no stored state, and holding a cross-tab lock across
        // an AES encryption would put every other tab behind this one's crypto.
        const sealed = await this.seal.seal(value);
        // No key, no cache. Degrades to the behaviour that shipped before this existed.
        if (sealed === null) return;

        await this.locked(async () => {
            const index = await this.sync();
            const scoped = this.scoped(domain, key);

            const previous = index.get(scoped);
            if (previous) this.sizes[domain] -= previous.bytes;

            const bytes = sealed.length + scoped.length;
            const entry: IndexEntry = {bytes, lastAccess: Date.now(), domain};
            index.set(scoped, entry);
            this.pending.set(scoped, entry);
            this.sizes[domain] += bytes;

            await this.withStore(s => s.set(scoped, sealed));
            await this.evict(domain, index);
            // Batched. The payload row above is written through either way, so what a lost batch
            // costs is an entry that reads as absent next launch and is refetched.
            await this.touchIndex(index);
        });
    }

    async delete(domain: CacheDomain, key: string): Promise<void> {
        await this.locked(async () => {
            const index = await this.sync();
            const scoped = this.scoped(domain, key);
            if (!index.has(scoped)) return;

            await this.discard(index, scoped);
            // Never batched: an entry that came back after a reload because its removal was still
            // sitting in a timer is not a degraded cache.
            await this.flushIndex(index);
        });
    }

    /** Every entry in one domain. Used by profile hydration, which genuinely wants all of them. */
    async all<T>(domain: CacheDomain): Promise<[string, T][]> {
        return await this.locked(async () => {
            const index = await this.sync();
            const prefix = this.prefix(domain);
            const out: [string, T][] = [];
            let reclaimed = false;

            // Snapshotted, because an unreadable entry is dropped from the index as it is found.
            for (const scoped of [...index.keys()]) {
                if (!scoped.startsWith(prefix)) continue;
                const raw = await this.withStore(s => s.get(scoped));
                const value = typeof raw === 'string' ? await this.seal.unseal<T>(raw) : null;
                if (value === null) {
                    // Same reclamation as get(), for the same reason.
                    await this.discard(index, scoped);
                    reclaimed = true;
                    continue;
                }
                out.push([scoped.slice(prefix.length), value]);
            }
            if (reclaimed) await this.touchIndex(index);
            return out;
        });
    }

    /** Drops this device's entries. Another account's entries are a different prefix. */
    async clear(): Promise<void> {
        await this.locked(async () => {
            const index = await this.sync();
            for (const scoped of [...index.keys()]) await this.discard(index, scoped);
            this.sizes.profile = 0;
            this.sizes.message = 0;
            // Never batched, and this one is the reason the rule exists: a clear() that did not
            // persist would leave a signed-out account's index - the set of user ids and
            // conversation ids this device cached - readable after the wipe meant to remove it.
            await this.flushIndex(index);
        });
    }

    /**
     * Drops least-recently-used entries until this domain is inside its reserve.
     *
     * <p>Scoped to the one domain, which is what makes a reserve a reserve: a profile write can
     * never drop a message entry, however much room the messages are using.</p>
     */
    private async evict(domain: CacheDomain, index: Map<string, IndexEntry>): Promise<void> {
        if (this.sizes[domain] <= DOMAIN_RESERVES[domain]) return;

        const victims = [...index.entries()]
            .filter(([, e]) => e.domain === domain)
            .sort((a, b) => a[1].lastAccess - b[1].lastAccess);

        for (const [scoped] of victims) {
            if (this.sizes[domain] <= DOMAIN_RESERVES[domain]) return;
            await this.discard(index, scoped);
        }
    }

    /** Drops one entry from the index, from the size accounting and from the store. */
    private async discard(index: Map<string, IndexEntry>, scoped: string): Promise<void> {
        const entry = index.get(scoped);
        if (entry) this.sizes[entry.domain] -= entry.bytes;
        index.delete(scoped);
        this.pending.set(scoped, null);
        await this.withStore(s => s.delete(scoped));
    }

    /** Runs one operation with this device's cache held against every other tab. */
    private locked<T>(body: () => Promise<T>): Promise<T> {
        return withWebLock(this.lockName, body, this.locks);
    }

    private prefix(domain: CacheDomain): string {
        return `${this.deviceId}${SEPARATOR}${domain}${SEPARATOR}`;
    }

    private scoped(domain: CacheDomain, key: string): string {
        return `${this.prefix(domain)}${key}`;
    }

    private indexKey(): string {
        return `__index${SEPARATOR}${this.deviceId}`;
    }

    private revisionKey(): string {
        return `${REVISION_PREFIX}${this.deviceId}`;
    }

    /**
     * The index, reloaded if any tab has written since the copy in memory was built.
     *
     * <p>A failed load is not memoised - {@link index} is only assigned once {@link load} has
     * resolved - so a `blocked` first attempt, another tab mid-upgrade, does not make this cache
     * unreadable for the rest of the session.</p>
     */
    private async sync(): Promise<Map<string, IndexEntry>> {
        const stored = await this.withStore(s => s.get(this.revisionKey()));
        const revision = typeof stored === 'string' ? stored : undefined;
        if (this.index !== undefined && this.indexReadable && revision === this.indexRevision) {
            return this.index;
        }

        const loaded = await this.load();
        // Whatever this tab has changed and not yet flushed wins over the reloaded copy: those
        // rows are on disk and this is the only tab that knows about them. Dropping them here
        // would leave payloads nothing lists - not evicted, not wiped, not served.
        for (const [scoped, entry] of this.pending) {
            if (entry === null) loaded.map.delete(scoped);
            else loaded.map.set(scoped, entry);
        }

        this.index = loaded.map;
        this.indexReadable = loaded.readable;
        this.indexRevision = revision;
        this.sizes.profile = 0;
        this.sizes.message = 0;
        for (const entry of loaded.map.values()) this.sizes[entry.domain] += entry.bytes;
        return loaded.map;
    }

    /**
     * Reads the index out of IndexedDB.
     *
     * <p>It is sealed like everything else - it holds the user ids and conversation ids this device
     * has cached, which is the contact graph the sealing exists to protect. Scoped by device id the
     * same way entries are, through {@link indexKey}, so one account's index can never be read by
     * another: a shared index would leak the set of cached ids even if the payloads themselves
     * stayed unreadable.</p>
     *
     * <p>An index that is <i>present</i> and will not open is reported as unreadable rather than as
     * empty, and the difference is load bearing - see {@link indexReadable}.</p>
     */
    private async load(): Promise<{map: Map<string, IndexEntry>; readable: boolean}> {
        const raw = await this.withStore(s => s.get(this.indexKey()));
        if (typeof raw !== 'string') return {map: new Map(), readable: true};

        const parsed = await this.seal.unseal<Record<string, IndexEntry>>(raw);
        if (parsed === null) return {map: new Map(), readable: false};
        return {map: new Map(Object.entries(parsed)), readable: true};
    }

    /**
     * Marks the index as written, so every other tab reloads.
     *
     * <p>Before the write it announces, not after, for the reason `mls-local-store.web.ts` gives: a
     * bump that survived a failed write costs other tabs one needless reload of data that has not
     * changed, while a write that survived a failed bump is invisible to them until something else
     * happens to bump it - and an index they do not know about is one they will overwrite.</p>
     */
    private async bump(): Promise<void> {
        const revision = `${this.writer}:${++this.writes}`;
        await this.withStore(s => s.set(this.revisionKey(), revision));
        this.indexRevision = revision;
    }

    /**
     * Persists the index now, or joins it to the current write window.
     *
     * <p>The first change after a quiet period is written through immediately - so a single `set()`
     * is durable the moment it resolves, which is what makes the cache survive a launch at all -
     * and everything within one window of that write shares a single flush at the end of it. The
     * window is measured from the last <i>write</i>, not from the last change, so a continuous
     * stream of writes cannot postpone the flush indefinitely.</p>
     */
    private async touchIndex(index: Map<string, IndexEntry>): Promise<void> {
        const since = Date.now() - this.lastIndexWrite;
        if (this.flushTimer === undefined && since >= this.indexWriteWindowMs) {
            await this.flushIndex(index);
            return;
        }
        this.scheduleFlush(Math.max(0, this.indexWriteWindowMs - since));
    }

    private scheduleFlush(delay: number): void {
        if (this.flushTimer !== undefined) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            void this.flushPending();
        }, delay);
    }

    /**
     * The batched flush's own entry point: the one place the lock is taken outside a public method.
     *
     * <p>That is not a nested acquisition - the timer fires with nothing held - and it is what makes
     * a batch safe: the flush revalidates against whatever the other tabs have done since the
     * changes were queued, exactly as a `set()` would have.</p>
     */
    private async flushPending(): Promise<void> {
        try {
            await this.locked(async () => await this.flushIndex(await this.sync()));
        } catch {
            // An index that could not be written is a cache miss next launch and nothing more.
            // Raised here it would be an unhandled rejection out of a timer, which is a reload.
        }
    }

    private async flushIndex(index: Map<string, IndexEntry>): Promise<void> {
        this.cancelFlush();
        this.lastIndexWrite = Date.now();
        if (this.pending.size === 0) return;

        const sealed = await this.seal.seal(Object.fromEntries(index));
        // No key: nothing can be written, and the changes stay pending for a later attempt.
        if (sealed === null) return;

        await this.bump();
        await this.withStore(s => s.set(this.indexKey(), sealed));
        this.pending.clear();
        // Whatever the stored copy was before, this tab has just published one it can read.
        this.indexReadable = true;
    }

    private cancelFlush(): void {
        if (this.flushTimer === undefined) return;
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
    }

    /** One reopen for a connection another tab's upgrade closed, as the MLS store does. */
    private async withStore<T>(op: (store: IdbStore) => Promise<T>): Promise<T> {
        try {
            return await op(await this.db());
        } catch (err) {
            if (!(err instanceof IdbStoreClosedError)) throw err;
            this.store = undefined;
            return await op(await this.db());
        }
    }

    private db(): Promise<IdbStore> {
        this.store ??= this.openDb().catch((err: unknown) => {
            this.store = undefined;
            throw err;
        });
        return this.store;
    }
}

/** Opens one account's cache. Injected so specs can point at `fake-indexeddb`. */
@Injectable({providedIn: 'root'})
export class CacheStoreFactory {
    private readonly stores = new Map<string, CacheStore>();

    constructor(private readonly seal: CacheSealService) {}

    open(deviceId: string): CacheStore {
        let store = this.stores.get(deviceId);
        if (!store) {
            store = new CacheStore(deviceId, this.seal);
            this.stores.set(deviceId, store);
        }
        return store;
    }
}
