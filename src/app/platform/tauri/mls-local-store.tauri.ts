import {MlsLocalStore, MlsLocalStoreFactory} from '../ports/mls-local-store.port';

/**
 * {@link MlsLocalStoreFactory} over `@tauri-apps/plugin-store`.
 *
 * <p>Returns what `MlsService` has always used: one `LazyStore` per file name, making the same calls
 * against the same two files - `mls-group-registry-{deviceId}.json` and
 * `mls-message-cache-{deviceId}.json`. <b>Nothing about the desktop's data changes</b>, which matters
 * because those files hold every context-to-group mapping this device has, the monotonic `#floor` that
 * stands between an encrypted context and a cleartext message, and the only copy of the plaintext of
 * every message it has read.</p>
 *
 * <p>`LazyStore` covers six of the seven methods structurally, so the shim below exists mostly to defer
 * the plugin `import()` to the first call, exactly as the settings adapter's does. The plugin keeps one
 * file per name, so two handles over one file see one map.</p>
 *
 * <p>The seventh, {@link MlsLocalStore.update}, is this shim's own: `LazyStore` has no compare-and-set,
 * and the port needs one because a browser has a writer per tab. Here there is one process and one
 * plugin-side map, so the whole of the cross-writer problem is gone - what is left is that two
 * <i>overlapping</i> calls in this process would still interleave across their `await`s, and that is
 * what the queue below removes.</p>
 */
export class TauriMlsLocalStoreFactory extends MlsLocalStoreFactory {
    open(file: string): MlsLocalStore {
        return new DeferredLazyStore(file);
    }
}

type StorePlugin = typeof import('@tauri-apps/plugin-store');

let loading: Promise<StorePlugin> | undefined;

/** The plugin module, imported once. A rejection is not memoised - one failed chunk load is not fatal. */
function plugin(): Promise<StorePlugin> {
    loading ??= import('@tauri-apps/plugin-store').catch((err: unknown) => {
        loading = undefined;
        throw err;
    });
    return loading;
}

/** The part of {@link MlsLocalStore} `LazyStore` satisfies on its own. */
type LazyStoreLike = Omit<MlsLocalStore, 'update'>;

/** A `LazyStore` constructed on first use, because {@link MlsLocalStoreFactory.open} is synchronous. */
class DeferredLazyStore implements MlsLocalStore {
    private instance: Promise<LazyStoreLike> | undefined;

    /**
     * Tail of the serialised {@link update} chain.
     *
     * <p>One process, so this is the whole of the mutual exclusion - there is no second writer to lock
     * out. It exists because `update` is three awaits long and JavaScript will happily run another one
     * inside them: two overlapping floor raises would both read the old value and the lower would land
     * second, which is the same backwards floor the web adapter takes a Web Lock to prevent.</p>
     */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly file: string) { }

    async get<T>(key: string): Promise<T | undefined> {
        return (await this.store()).get<T>(key);
    }

    async set(key: string, value: unknown): Promise<void> {
        await (await this.store()).set(key, value);
    }

    async delete(key: string): Promise<boolean> {
        return (await this.store()).delete(key);
    }

    update<T>(key: string, next: (current: T | undefined) => T | undefined): Promise<T | undefined> {
        // The previous link's failure is not this call's, so it is swallowed here rather than
        // propagated - one rejected update must not poison every later one on the same file.
        const result = this.queue.then(() => this.applyUpdate(key, next), () => this.applyUpdate(key, next));
        this.queue = result.catch(() => undefined);
        return result;
    }

    async entries<T>(): Promise<[string, T][]> {
        return (await this.store()).entries<T>();
    }

    async clear(): Promise<void> {
        await (await this.store()).clear();
    }

    async save(): Promise<void> {
        await (await this.store()).save();
    }

    private async applyUpdate<T>(
        key: string,
        next: (current: T | undefined) => T | undefined,
    ): Promise<T | undefined> {
        const store = await this.store();
        const current = await store.get<T>(key);
        const value = next(current);
        // Returning what it was given means "leave it alone", and writing it back anyway would turn
        // every no-op floor raise into a file write.
        if (value === current) return current;
        if (value === undefined) await store.delete(key);
        else await store.set(key, value);
        return value;
    }

    private store(): Promise<LazyStoreLike> {
        this.instance ??= plugin()
            .then(({LazyStore}) => new LazyStore(this.file) as LazyStoreLike)
            .catch((err: unknown) => {
                this.instance = undefined;
                throw err;
            });
        return this.instance;
    }
}
