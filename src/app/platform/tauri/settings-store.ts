import {SettingsStore, SettingsStoreFactory} from '../ports/settings-store.port';

/**
 * {@link SettingsStoreFactory} over `@tauri-apps/plugin-store`.
 *
 * <p>Returns what the desktop path has always used: one `LazyStore` per
 * `open()` call, over the same file, making the same four calls. `LazyStore` is lazy by construction
 * so an unused one costs nothing, and keeping that lifetime identical is what makes the port a pure
 * indirection rather than an edit to the desktop path.</p>
 */
export class TauriSettingsStoreFactory extends SettingsStoreFactory {
    open(file: string): SettingsStore {
        return new DeferredLazyStore(file);
    }
}

type StorePlugin = typeof import('@tauri-apps/plugin-store');

let loading: Promise<StorePlugin> | undefined;

/**
 * The plugin module, imported once.
 *
 * <p>A rejection is not memoised: one failed chunk load would otherwise make every settings read for
 * the rest of the session fail, and the first thing this file answers is the device id.</p>
 */
function plugin(): Promise<StorePlugin> {
    loading ??= import('@tauri-apps/plugin-store').catch((err: unknown) => {
        loading = undefined;
        throw err;
    });
    return loading;
}

/**
 * A `LazyStore` that is constructed on the first call rather than by `open()`.
 *
 * <p><b>Why this shim exists at all:</b> {@link SettingsStoreFactory.open} is synchronous - its
 * callers open a store inline in the middle of an operation - while loading the plugin is not. So the
 * store handed back is
 * a real `SettingsStore` immediately and the `import()` happens inside the first `get`/`set`, which is
 * the only place there is already an `await`.</p>
 *
 * <p>The instance is memoised per {@link open} call, so repeated reads through one handle share one
 * `LazyStore`, exactly as before. The plugin itself keeps one file per name, so two handles over the
 * same file see the same data - which the settings readers rely on, since each of them re-opens the
 * store per write.</p>
 */
class DeferredLazyStore implements SettingsStore {
    private instance: Promise<SettingsStore> | undefined;

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

    async save(): Promise<void> {
        await (await this.store()).save();
    }

    private store(): Promise<SettingsStore> {
        this.instance ??= plugin()
            .then(({LazyStore}) => new LazyStore(this.file) as SettingsStore)
            .catch((err: unknown) => {
                this.instance = undefined;
                throw err;
            });
        return this.instance;
    }
}
