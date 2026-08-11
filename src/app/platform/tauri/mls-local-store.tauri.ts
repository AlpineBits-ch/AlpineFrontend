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
 * <p>`LazyStore` already satisfies {@link MlsLocalStore} structurally - it has all six methods - so the
 * shim below exists only to defer the plugin `import()` to the first call, exactly as the settings
 * adapter's does. The plugin keeps one file per name, so two handles over one file see one map.</p>
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

/** A `LazyStore` constructed on first use, because {@link MlsLocalStoreFactory.open} is synchronous. */
class DeferredLazyStore implements MlsLocalStore {
    private instance: Promise<MlsLocalStore> | undefined;

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

    async entries<T>(): Promise<[string, T][]> {
        return (await this.store()).entries<T>();
    }

    async clear(): Promise<void> {
        await (await this.store()).clear();
    }

    async save(): Promise<void> {
        await (await this.store()).save();
    }

    private store(): Promise<MlsLocalStore> {
        this.instance ??= plugin()
            .then(({LazyStore}) => new LazyStore(this.file) as MlsLocalStore)
            .catch((err: unknown) => {
                this.instance = undefined;
                throw err;
            });
        return this.instance;
    }
}
