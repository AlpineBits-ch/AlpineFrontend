import {Injectable} from '@angular/core';

import {CacheSealService} from '../services/cache/cache-seal.service';
import {IdbStore, IdbStoreClosedError, openStore} from './web/idb';

const DB_NAME = 'alpine-cache';
const STORE_NAME = 'entries';

/** Separates device, domain and key. None of the three contains it. */
const SEPARATOR = '::';

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

    /** Whether the in-memory index holds changes the stored copy does not. */
    private indexDirty = false;

    /** The pending batched flush, if one is scheduled. */
    private flushTimer: ReturnType<typeof setTimeout> | undefined;

    /** When the index was last written, so the first change after a quiet period goes straight out. */
    private lastIndexWrite = 0;

    /**
     * @param indexWriteWindowMs how long index writes are batched for. Injectable so a spec can
     *     prove the batching without waiting on a clock, and prove the unbatched paths at zero.
     */
    constructor(
        private readonly deviceId: string,
        private readonly seal: CacheSealService,
        private readonly openDb: () => Promise<IdbStore> = () => openStore(DB_NAME, STORE_NAME),
        private readonly indexWriteWindowMs: number = INDEX_WRITE_WINDOW_MS,
    ) {}

    /** Bytes currently held for one domain. Read from the index; touches no payload. */
    sizeOf(domain: CacheDomain): number {
        return this.sizes[domain];
    }

    async get<T>(domain: CacheDomain, key: string): Promise<T | undefined> {
        const index = await this.loadIndex();
        const scoped = this.scoped(domain, key);
        const entry = index.get(scoped);
        if (!entry) return undefined;

        const raw = await this.withStore(s => s.get(scoped));
        const value = typeof raw === 'string' ? await this.seal.unseal<T>(raw) : null;
        if (value === null) {
            // The payload is missing, or is sealed under something this key will not open. Either
            // way the entry can never be served again - and left in the index it would keep
            // charging its bytes against the domain's ceiling for the life of the cache, evicting
            // entries that are actually readable to make room for one that is not.
            await this.discard(index, scoped);
            await this.touchIndex(index);
            return undefined;
        }

        // In-memory only - see the class comment on why this does not flush the index.
        entry.lastAccess = Date.now();
        return value;
    }

    async set(domain: CacheDomain, key: string, value: unknown): Promise<void> {
        const sealed = await this.seal.seal(value);
        // No key, no cache. Degrades to the behaviour that shipped before this existed.
        if (sealed === null) return;

        const index = await this.loadIndex();
        const scoped = this.scoped(domain, key);

        const previous = index.get(scoped);
        if (previous) this.sizes[domain] -= previous.bytes;

        const bytes = sealed.length + scoped.length;
        index.set(scoped, {bytes, lastAccess: Date.now(), domain});
        this.indexDirty = true;
        this.sizes[domain] += bytes;

        await this.withStore(s => s.set(scoped, sealed));
        await this.evict(domain, index);
        // Batched. The payload row above is written through either way, so what a lost batch costs
        // is an entry that reads as absent next launch and is refetched.
        await this.touchIndex(index);
    }

    async delete(domain: CacheDomain, key: string): Promise<void> {
        const index = await this.loadIndex();
        const scoped = this.scoped(domain, key);
        if (!index.has(scoped)) return;

        await this.discard(index, scoped);
        // Never batched: an entry that came back after a reload because its removal was still
        // sitting in a timer is not a degraded cache.
        await this.flushIndex(index);
    }

    /** Every entry in one domain. Used by profile hydration, which genuinely wants all of them. */
    async all<T>(domain: CacheDomain): Promise<[string, T][]> {
        const index = await this.loadIndex();
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
    }

    /** Drops this device's entries. Another account's entries are a different prefix. */
    async clear(): Promise<void> {
        const index = await this.loadIndex();
        for (const scoped of [...index.keys()]) await this.discard(index, scoped);
        this.sizes.profile = 0;
        this.sizes.message = 0;
        // Never batched, and this one is the reason the rule exists: a clear() that did not persist
        // would leave a signed-out account's index - the set of user ids and conversation ids this
        // device cached - readable after the wipe that was supposed to remove it.
        await this.flushIndex(index);
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
        this.indexDirty = true;
        await this.withStore(s => s.delete(scoped));
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

    /**
     * The index, sealed like everything else - it holds the user ids and conversation ids this
     * device has cached, which is the contact graph the sealing exists to protect. Scoped by
     * device id the same way entries are, through {@link indexKey}, so one account's index can
     * never be read by another - a shared index would leak the set of cached ids even if the
     * payloads themselves stayed unreadable.
     */
    private async loadIndex(): Promise<Map<string, IndexEntry>> {
        if (this.index) return this.index;

        const raw = await this.withStore(s => s.get(this.indexKey()));
        const parsed = typeof raw === 'string'
            ? await this.seal.unseal<Record<string, IndexEntry>>(raw)
            : null;

        const index = new Map<string, IndexEntry>(Object.entries(parsed ?? {}));
        this.sizes.profile = 0;
        this.sizes.message = 0;
        for (const entry of index.values()) this.sizes[entry.domain] += entry.bytes;

        this.index = index;
        return index;
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

    /** The batched flush's own entry point, so a failure there cannot reach an error handler. */
    private async flushPending(): Promise<void> {
        try {
            await this.flushIndex(await this.loadIndex());
        } catch {
            // An index that could not be written is a cache miss next launch and nothing more.
            // Raised here it would be an unhandled rejection out of a timer, which is a reload.
        }
    }

    private async flushIndex(index: Map<string, IndexEntry>): Promise<void> {
        this.cancelFlush();
        this.lastIndexWrite = Date.now();
        if (!this.indexDirty) return;

        const sealed = await this.seal.seal(Object.fromEntries(index));
        // No key: nothing can be written, and the changes stay dirty for a later attempt.
        if (sealed === null) return;

        await this.withStore(s => s.set(this.indexKey(), sealed));
        this.indexDirty = false;
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
