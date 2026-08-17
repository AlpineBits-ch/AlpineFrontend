import {MlsLocalStore, MlsLocalStoreFactory} from '../ports/mls-local-store.port';
import {IdbStore, IdbStoreClosedError, openStore} from './idb';
import {criticalSectionName, detectLockManager, withWebLock} from './session-lock';

/**
 * Its own database, for the reason `WebSecureStore` gives: adding an object store to an existing
 * database is a version change, and a version change closes every other connection to it. One
 * database per consumer removes the interaction rather than handling it.
 */
const DB_NAME = 'alpine-mls-stores';
const STORE_NAME = 'entries';

/** Separates the file name from the key. Neither file's keys contain it. */
const SEPARATOR = '::';

/**
 * Prefix of the per-file revision marker, kept in the same object store as the entries it describes.
 *
 * <p>Deliberately not inside the file's own namespace: `load()` and `clear()` are scoped by
 * `${file}${SEPARATOR}`, and a marker that matched that would be exported as an entry by
 * `MlsService.exportBackup` and deleted by a wipe. Nothing can collide with it from the other side
 * either, because the only way an entry key could begin `__rev::` is a <i>file</i> named `__rev`, and
 * both file names are `mls-{group-registry,message-cache}-{deviceId}.json`.</p>
 */
const REVISION_PREFIX = `__rev${SEPARATOR}`;

/** The subsystem name these stores take their cross-tab locks under. */
const LOCK_AREA = 'mls-store';

/**
 * {@link MlsLocalStoreFactory} over IndexedDB.
 *
 * <p><b>IndexedDB rather than `localStorage`</b>, unlike the settings adapter, for two reasons. The
 * message cache holds the plaintext of every message this device has read, up to 5,000 entries, which
 * is well past `localStorage`'s few megabytes - and exceeding it there throws on write, which for this
 * store means losing history silently. And the settings adapter's browser namespace is deliberately
 * one flat prefix shared by every "file", so `clear()` through it would take the account registry and
 * the device ids with it.</p>
 *
 * <p>One object store, with keys namespaced by file name, so the two MLS files and any future one share
 * a single connection and a single version. `entries()` and `clear()` are scoped by that prefix; a
 * wipe of the message cache cannot touch the group registry.</p>
 *
 * @param locks the profile's lock manager. Injectable because jsdom has none, and because two "tabs"
 *     in one spec have to share one manager for the cross-tab guarantees below to be provable at all.
 * @param openDb opens the shared object store. Injectable so a spec can hand in a `fake-indexeddb`
 *     factory, and so two "tabs" in one spec can be pointed at one database.
 */
export class WebMlsLocalStoreFactory extends MlsLocalStoreFactory {
    constructor(
        private readonly locks: LockManager | undefined = detectLockManager(),
        private readonly openDb: () => Promise<IdbStore> = () => openStore(DB_NAME, STORE_NAME),
    ) {
        super();
    }

    open(file: string): MlsLocalStore {
        return new IdbMlsLocalStore(file, this.locks, this.openDb);
    }
}

/**
 * One namespace of the shared object store, mirrored in memory.
 *
 * <p><b>The mirror is not an optimisation of reads but of `entries()`.</b> `pruneMessageCache` runs on
 * every message cached and asks for every entry to sort them by age; served from IndexedDB that is one
 * request per cached message, several thousand of them, on the path that renders a conversation. The
 * desktop store behaves the same way - `LazyStore` holds the whole file in memory and `save()` flushes
 * it - so this keeps the two hosts' cost profile identical as well as their semantics.</p>
 *
 * <p>Writes go to IndexedDB <i>first</i> and update the mirror only on success, so a rejected write
 * cannot leave a value readable that was never stored. `save()` is a no-op because there is nothing
 * buffered; it is kept because the caller cannot know which backend it holds.</p>
 *
 * <h3>Two tabs, one file</h3>
 *
 * <p><b>This used to be a documented limitation and it was a security defect.</b> The mirror was loaded
 * once and never revalidated, so a second tab of the same account never saw this one's writes for the
 * rest of its life. The single-session guard does not cover it: that guard owns the <i>engine</i>, and
 * a tab it has blocked still reads this file. What it reads out of a stale mirror is `ctx#floor` - the
 * monotonic encryption floor - and a floor read as absent means "this context was never encrypted
 * here", which is precisely the answer that licenses composing cleartext into an encrypted
 * conversation (§L.9). The same staleness survives a takeover: a tab granted the lock after the other
 * closed restores the engine blob and would still be reading a registry from its own boot.</p>
 *
 * <p>So every operation on this store now runs inside one exclusive Web Lock named for the file, and
 * begins by <b>revalidating the mirror</b>:</p>
 * <ul>
 *   <li>Each write bumps a per-file revision marker in the same database, to a token unique to this tab
 *       and this write. Uniqueness is all that is asked of it - it is compared, never ordered - so
 *       there is no clock to trust and no counter to keep in sync between tabs.</li>
 *   <li>{@link sync} reads that marker and reloads the whole namespace when it differs from the one the
 *       mirror was built at. One small get in the common case, a full load only when another tab has
 *       actually written.</li>
 *   <li>The lock is what makes those two safe together. Without it, two tabs that revalidate, write and
 *       bump concurrently can both end up believing their mirror matches the stored marker while one of
 *       them is missing the other's write - the marker only records <i>who wrote last</i>, not what
 *       everyone else has seen. Serialising the whole revalidate-write-bump sequence removes that
 *       interleaving rather than trying to detect it.</li>
 * </ul>
 *
 * <p>Reads take the lock too, which is not symmetry for its own sake: a reader that revalidated outside
 * it could observe a writer's new value with its old marker, conclude the mirror is current and cache
 * the gap for as long as the tab lives. It is one uncontended lock acquisition and one small get.</p>
 *
 * <p><b>Never nest these.</b> Every public method takes the lock exactly once and every private helper
 * below takes none; a nested request on the same name queues behind its own holder forever.</p>
 */
class IdbMlsLocalStore implements MlsLocalStore {
    private store: Promise<IdbStore> | undefined;

    /** The namespace in memory, or undefined before the first load. */
    private mirror: Map<string, unknown> | undefined;

    /** The revision marker {@link mirror} was built at. `undefined` is a file nothing has written. */
    private mirrorRevision: string | undefined;

    /** Distinguishes this tab's writes from every other tab's. Compared, never ordered. */
    private readonly writer = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    private writes = 0;

    private readonly lockName: string;

    constructor(
        private readonly file: string,
        private readonly locks: LockManager | undefined,
        private readonly openDb: () => Promise<IdbStore>,
    ) {
        this.lockName = criticalSectionName(LOCK_AREA, file);
    }

    async get<T>(key: string): Promise<T | undefined> {
        return await this.locked(async () => (await this.sync()).get(key) as T | undefined);
    }

    async set(key: string, value: unknown): Promise<void> {
        await this.locked(async () => {
            const map = await this.sync();
            await this.bump();
            await this.withStore(store => store.set(this.scoped(key), JSON.stringify(value)));
            map.set(key, value);
        });
    }

    async delete(key: string): Promise<boolean> {
        return await this.locked(async () => {
            const map = await this.sync();
            const existed = map.has(key);
            await this.bump();
            await this.withStore(store => store.delete(this.scoped(key)));
            map.delete(key);
            return existed;
        });
    }

    async update<T>(key: string, next: (current: T | undefined) => T | undefined): Promise<T | undefined> {
        return await this.locked(async () => {
            const map = await this.sync();
            const current = map.get(key) as T | undefined;
            const value = next(current);
            // Returning what it was given means "leave it alone". Writing it back anyway would make
            // every no-op floor raise a write, and would bump the revision for every other tab.
            if (value === current) return current;

            await this.bump();
            if (value === undefined) {
                await this.withStore(store => store.delete(this.scoped(key)));
                map.delete(key);
            } else {
                await this.withStore(store => store.set(this.scoped(key), JSON.stringify(value)));
                map.set(key, value);
            }
            return value;
        });
    }

    async entries<T>(): Promise<[string, T][]> {
        return await this.locked(async () => [...(await this.sync()).entries()] as [string, T][]);
    }

    async clear(): Promise<void> {
        await this.locked(async () => {
            const map = await this.sync();
            await this.bump();
            // Scoped deletes rather than `store.clear()`: the object store is shared with the other MLS
            // file, and clearing the message cache must never drop the group registry - losing the
            // registry makes every restored group unaddressable and reads as "never encrypted", which is
            // the §L.9 downgrade the encryption floor exists to refuse.
            for (const key of [...map.keys()]) {
                await this.withStore(store => store.delete(this.scoped(key)));
                map.delete(key);
            }
        });
    }

    async save(): Promise<void> {
        // Nothing is buffered: every `set` and `delete` above has already been written through.
    }

    /**
     * Runs one operation with this file held against every other tab.
     *
     * <p>The lock is per file, not per database, so pruning the message cache does not hold up a floor
     * read on the group registry.</p>
     */
    private locked<T>(body: () => Promise<T>): Promise<T> {
        return withWebLock(this.lockName, body, this.locks);
    }

    private scoped(key: string): string {
        return `${this.file}${SEPARATOR}${key}`;
    }

    private revisionKey(): string {
        return `${REVISION_PREFIX}${this.file}`;
    }

    /**
     * The mirror, reloaded if any tab has written since it was built.
     *
     * <p>A failed load is not memoised - `this.mirror` is only assigned once `load()` has resolved - so
     * a `blocked` first attempt, another tab mid-upgrade, does not make this file unreadable for the
     * rest of the session.</p>
     */
    private async sync(): Promise<Map<string, unknown>> {
        const stored = await this.withStore(store => store.get(this.revisionKey()));
        const revision = typeof stored === 'string' ? stored : undefined;
        if (this.mirror !== undefined && revision === this.mirrorRevision) return this.mirror;

        const map = await this.load();
        this.mirror = map;
        this.mirrorRevision = revision;
        return map;
    }

    /**
     * Marks the file as written, so every other tab reloads.
     *
     * <p><b>Before the write it announces, not after.</b> A bump that survived a failed write costs the
     * other tabs one needless reload of data that has not changed; a write that survived a failed bump
     * would be invisible to them until something else happened to bump it, which for the encryption
     * floor is a downgrade with no bound on how long it lasts.</p>
     */
    private async bump(): Promise<void> {
        const revision = `${this.writer}:${++this.writes}`;
        await this.withStore(store => store.set(this.revisionKey(), revision));
        this.mirrorRevision = revision;
    }

    /**
     * Reads the whole namespace out of IndexedDB.
     *
     * <p>A value that will not parse is reported as absent rather than thrown: for the message cache
     * that is a cache miss and the message renders as undecryptable, and for the registry it is what a
     * cold install looks like. Rejecting instead would take the boot down, which is what the browser
     * settings adapter documents at length.</p>
     */
    private async load(): Promise<Map<string, unknown>> {
        const prefix = `${this.file}${SEPARATOR}`;
        const map = new Map<string, unknown>();

        for (const scoped of await this.withStore(store => store.keys())) {
            if (!scoped.startsWith(prefix)) continue;
            const raw = await this.withStore(store => store.get(scoped));
            if (typeof raw !== 'string') continue;
            try {
                map.set(scoped.slice(prefix.length), JSON.parse(raw));
            } catch {
                // Not JSON this store wrote. Treated as absent - see the comment above.
            }
        }
        return map;
    }

    /** One reopen for a connection another tab's upgrade closed, exactly as `WebSecureStore` does. */
    private async withStore<T>(op: (store: IdbStore) => Promise<T>): Promise<T> {
        try {
            return await op(await this.blobStore());
        } catch (err) {
            if (!(err instanceof IdbStoreClosedError)) throw err;
            this.store = undefined;
            return await op(await this.blobStore());
        }
    }

    private blobStore(): Promise<IdbStore> {
        this.store ??= this.openDb().catch((err: unknown) => {
            this.store = undefined;
            throw err;
        });
        return this.store;
    }
}
