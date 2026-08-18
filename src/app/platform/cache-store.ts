import {Injectable} from '@angular/core';

import {CacheSealService} from '../services/cache/cache-seal.service';
import {IdbStore, IdbStoreClosedError, openStore} from './web/idb';
import {criticalSectionName, detectLockManager, withWebLock} from './web/session-lock';

const DB_NAME = 'alpine-cache';
const STORE_NAME = 'entries';

/** Separates device, domain and key. None of the three contains it. */
const SEPARATOR = '::';

/** Prefix of the per-device revision marker, kept in the same object store as the index. */
const REVISION_PREFIX = `__rev${SEPARATOR}`;

/** The subsystem name this store takes its cross-tab locks under. */
const LOCK_AREA = 'cache-store';

export type CacheDomain = 'profile' | 'message' | 'conversation';

/** The hard ceiling each domain is held to, in bytes. Domains never borrow from each other. */
export const DOMAIN_RESERVES: Record<CacheDomain, number> = {
    profile: 5 * 1024 * 1024,
    message: 15 * 1024 * 1024,
    conversation: 1 * 1024 * 1024,
};

/** How long index writes are batched for, in milliseconds. */
const INDEX_WRITE_WINDOW_MS = 200;

interface IndexEntry {
    bytes: number;
    lastAccess: number;
    domain: CacheDomain;
}

/**
 * A sealed, byte-budgeted cache over IndexedDB.
 *
 * Never nest the cross-tab lock: every public method takes it exactly once and no private helper
 * below takes any, because a nested request on one name queues behind its own holder forever.
 */
export class CacheStore {
    private store: Promise<IdbStore> | undefined;
    private index: Map<string, IndexEntry> | undefined;
    private readonly sizes: Record<CacheDomain, number> = {profile: 0, message: 0, conversation: 0};

    /** The revision marker {@link index} was built at. `undefined` is a cache nothing has written. */
    private indexRevision: string | undefined;

    /** False when the stored index was present and would not open, so the copy in memory is a guess. */
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
     * @param indexWriteWindowMs how long index writes are batched for.
     * @param locks the profile's lock manager.
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
                // Unreadable payload: reclaim it so its bytes stop charging against the ceiling.
                await this.discard(index, scoped);
                await this.touchIndex(index);
                return undefined;
            }

            // In-memory only. A read never flushes the index.
            entry.lastAccess = Date.now();
            return value;
        });
    }

    async set(domain: CacheDomain, key: string, value: unknown): Promise<void> {
        // Sealed outside the lock: holding it across an AES encryption would stall every other tab.
        const sealed = await this.seal.seal(value);
        // No key, no cache.
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
            // Batched. The payload row above is written through either way.
            await this.touchIndex(index);
        });
    }

    async delete(domain: CacheDomain, key: string): Promise<void> {
        await this.locked(async () => {
            const index = await this.sync();
            const scoped = this.scoped(domain, key);
            if (!index.has(scoped)) return;

            await this.discard(index, scoped);
            // Never batched: a removal must not sit in a timer and come back after a reload.
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

    /**
     * Drops this device's entries. Another account's entries are a different prefix.
     *
     * The object store is the authority here, not the index: rows the index does not list must
     * still be wiped.
     */
    async clear(): Promise<void> {
        await this.locked(async () => {
            const index = await this.sync();
            for (const scoped of [...index.keys()]) await this.discard(index, scoped);
            this.sizes.profile = 0;
            this.sizes.message = 0;
            this.sizes.conversation = 0;
            await this.purgeStoredRows();
            // Never batched: an unflushed clear() leaves the signed-out account's index readable.
            await this.flushIndex(index);
        });
    }

    /**
     * Deletes every row in the object store under this device's entry prefix, listed or not.
     *
     * Takes no lock: {@link clear} is already inside the exclusive one.
     */
    private async purgeStoredRows(): Promise<void> {
        const prefix = `${this.deviceId}${SEPARATOR}`;
        const keys = await this.withStore(s => s.keys());
        for (const key of keys) {
            if (key.startsWith(prefix)) await this.withStore(s => s.delete(key));
        }
    }

    /** Drops least-recently-used entries until this domain is inside its reserve. */
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

    /** The index, reloaded if any tab has written since the copy in memory was built. */
    private async sync(): Promise<Map<string, IndexEntry>> {
        const stored = await this.withStore(s => s.get(this.revisionKey()));
        const revision = typeof stored === 'string' ? stored : undefined;
        if (this.index !== undefined && this.indexReadable && revision === this.indexRevision) {
            return this.index;
        }

        const loaded = await this.load();
        // This tab's unflushed changes must win over the reloaded copy, or their rows are orphaned.
        for (const [scoped, entry] of this.pending) {
            if (entry === null) loaded.map.delete(scoped);
            else loaded.map.set(scoped, entry);
        }

        this.index = loaded.map;
        this.indexReadable = loaded.readable;
        this.indexRevision = revision;
        this.sizes.profile = 0;
        this.sizes.message = 0;
        this.sizes.conversation = 0;
        for (const entry of loaded.map.values()) this.sizes[entry.domain] += entry.bytes;
        return loaded.map;
    }

    /**
     * Reads the sealed, device-scoped index out of IndexedDB.
     *
     * An index that is present and will not open reports as unreadable, never as empty.
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
     * Must run before the write it announces, never after.
     */
    private async bump(): Promise<void> {
        const revision = `${this.writer}:${++this.writes}`;
        await this.withStore(s => s.set(this.revisionKey(), revision));
        this.indexRevision = revision;
    }

    /** Persists the index now, or joins it to the current write window. */
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

    /** The batched flush's own entry point: the one place the lock is taken outside a public method. */
    private async flushPending(): Promise<void> {
        try {
            await this.locked(async () => await this.flushIndex(await this.sync()));
        } catch {
            // Swallowed: raised here it would be an unhandled rejection out of a timer.
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
