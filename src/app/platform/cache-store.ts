import {Injectable} from '@angular/core';

import {CacheSealService} from '../services/cache/cache-seal.service';
import {IdbStore, IdbStoreClosedError, openStore} from './web/idb';

const DB_NAME = 'alpine-cache';
const STORE_NAME = 'entries';

/** Separates device, domain and key. None of the three contains it. */
const SEPARATOR = '::';

export type CacheDomain = 'profile' | 'message';

/**
 * The floor each domain is guaranteed, in bytes.
 *
 * <p>A floor, not an allocation: a domain may grow into headroom another is not using, and gives it
 * back when the owner needs it. What the floor forbids is one domain evicting another <i>below</i>
 * its own. Profiles are tiny and are the thing whose absence is visible on screen, so a chatty
 * channel must never be able to push them out.</p>
 */
export const DOMAIN_RESERVES: Record<CacheDomain, number> = {
    profile: 5 * 1024 * 1024,
    message: 15 * 1024 * 1024,
};

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
 * <h3>`get()` does not persist the index</h3>
 *
 * <p>The obvious design bumps `lastAccess` and writes the whole index back on every read. Profile
 * hydration reads every cached entry on startup, so that turns a cold start into N serialised
 * IndexedDB writes of the entire index - exactly the cost the separate-index design exists to avoid.
 * Instead `get()` only updates the in-memory index entry; the index is persisted on the write paths
 * that already persist it (`set`, `delete`, `clear`). If the app is killed between a read and the
 * next write, that read's `lastAccess` bump is lost and eviction may pick a slightly staler victim -
 * eviction accuracy degrades, nothing corrupts and nothing becomes unreadable.</p>
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

    constructor(
        private readonly deviceId: string,
        private readonly seal: CacheSealService,
        private readonly openDb: () => Promise<IdbStore> = () => openStore(DB_NAME, STORE_NAME),
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
        if (typeof raw !== 'string') return undefined;

        const value = await this.seal.unseal<T>(raw);
        if (value === null) return undefined;

        // In-memory only - see the class comment on why this does not call writeIndex().
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
        this.sizes[domain] += bytes;

        await this.withStore(s => s.set(scoped, sealed));
        await this.evict(domain, index);
        await this.writeIndex(index);
    }

    async delete(domain: CacheDomain, key: string): Promise<void> {
        const index = await this.loadIndex();
        const scoped = this.scoped(domain, key);
        const entry = index.get(scoped);
        if (!entry) return;

        this.sizes[domain] -= entry.bytes;
        index.delete(scoped);
        await this.withStore(s => s.delete(scoped));
        await this.writeIndex(index);
    }

    /** Every entry in one domain. Used by profile hydration, which genuinely wants all of them. */
    async all<T>(domain: CacheDomain): Promise<[string, T][]> {
        const index = await this.loadIndex();
        const prefix = this.prefix(domain);
        const out: [string, T][] = [];

        for (const scoped of index.keys()) {
            if (!scoped.startsWith(prefix)) continue;
            const raw = await this.withStore(s => s.get(scoped));
            if (typeof raw !== 'string') continue;
            const value = await this.seal.unseal<T>(raw);
            if (value !== null) out.push([scoped.slice(prefix.length), value]);
        }
        return out;
    }

    /** Drops this device's entries. Another account's entries are a different prefix. */
    async clear(): Promise<void> {
        const index = await this.loadIndex();
        for (const scoped of [...index.keys()]) {
            await this.withStore(s => s.delete(scoped));
            index.delete(scoped);
        }
        this.sizes.profile = 0;
        this.sizes.message = 0;
        await this.writeIndex(index);
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

        for (const [scoped, entry] of victims) {
            if (this.sizes[domain] <= DOMAIN_RESERVES[domain]) return;
            this.sizes[domain] -= entry.bytes;
            index.delete(scoped);
            await this.withStore(s => s.delete(scoped));
        }
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

    private async writeIndex(index: Map<string, IndexEntry>): Promise<void> {
        const sealed = await this.seal.seal(Object.fromEntries(index));
        if (sealed === null) return;
        await this.withStore(s => s.set(this.indexKey(), sealed));
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
