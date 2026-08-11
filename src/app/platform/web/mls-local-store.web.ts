import {MlsLocalStore, MlsLocalStoreFactory} from '../ports/mls-local-store.port';
import {IdbStore, IdbStoreClosedError, openStore} from './idb';

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
 */
export class WebMlsLocalStoreFactory extends MlsLocalStoreFactory {
    open(file: string): MlsLocalStore {
        return new IdbMlsLocalStore(file);
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
 * <p><b>One tab at a time.</b> A second tab of the same account gets its own mirror and will not see
 * this one's writes. That is a real limitation and it is inherited rather than introduced: two tabs
 * already mean two in-memory MLS engines writing over one another's state blob, which no local store
 * can reconcile. It needs a single-session guard at the engine level, not a cache-coherency scheme
 * here.</p>
 */
class IdbMlsLocalStore implements MlsLocalStore {
    private store: Promise<IdbStore> | undefined;
    private mirror: Promise<Map<string, unknown>> | undefined;

    constructor(private readonly file: string) { }

    async get<T>(key: string): Promise<T | undefined> {
        return (await this.entriesMap()).get(key) as T | undefined;
    }

    async set(key: string, value: unknown): Promise<void> {
        const map = await this.entriesMap();
        await this.withStore(store => store.set(this.scoped(key), JSON.stringify(value)));
        map.set(key, value);
    }

    async delete(key: string): Promise<boolean> {
        const map = await this.entriesMap();
        const existed = map.has(key);
        await this.withStore(store => store.delete(this.scoped(key)));
        map.delete(key);
        return existed;
    }

    async entries<T>(): Promise<[string, T][]> {
        return [...(await this.entriesMap()).entries()] as [string, T][];
    }

    async clear(): Promise<void> {
        const map = await this.entriesMap();
        // Scoped deletes rather than `store.clear()`: the object store is shared with the other MLS
        // file, and clearing the message cache must never drop the group registry - losing the
        // registry makes every restored group unaddressable and reads as "never encrypted", which is
        // the §L.9 downgrade the encryption floor exists to refuse.
        for (const key of [...map.keys()]) {
            await this.withStore(store => store.delete(this.scoped(key)));
            map.delete(key);
        }
    }

    async save(): Promise<void> {
        // Nothing is buffered: every `set` and `delete` above has already been written through.
    }

    private scoped(key: string): string {
        return `${this.file}${SEPARATOR}${key}`;
    }

    /**
     * The namespace, read once.
     *
     * <p>A rejection is not memoised, so a `blocked` first attempt - another tab mid-upgrade - does not
     * make this file unreadable for the rest of the session. A value that will not parse is reported as
     * absent rather than thrown: for the message cache that is a cache miss and the message renders as
     * undecryptable, and for the registry it is what a cold install looks like. Rejecting instead
     * would take the boot down, which is what the browser settings adapter documents at length.</p>
     */
    private entriesMap(): Promise<Map<string, unknown>> {
        this.mirror ??= this.load().catch((err: unknown) => {
            this.mirror = undefined;
            throw err;
        });
        return this.mirror;
    }

    private async load(): Promise<Map<string, unknown>> {
        const prefix = `${this.file}${SEPARATOR}`;
        const store = await this.blobStore();
        const map = new Map<string, unknown>();

        for (const scoped of await store.keys()) {
            if (!scoped.startsWith(prefix)) continue;
            const raw = await store.get(scoped);
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
        this.store ??= openStore(DB_NAME, STORE_NAME).catch((err: unknown) => {
            this.store = undefined;
            throw err;
        });
        return this.store;
    }
}
