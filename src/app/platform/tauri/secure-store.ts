import {SecureStore} from '../ports/secure-store.port';

/**
 * {@link SecureStore} over the OS keychain, through `tauri-plugin-secure-storage`.
 *
 * <p>The same store the MLS signing keys, the wrapped master key and the push token have always been
 * written to, called with the same key names and the same three methods - so a desktop install that
 * upgrades onto the port layer finds every entry exactly where it left it. Renaming a key here would
 * present as this device being ejected from every group it belongs to, not as a storage bug.</p>
 *
 * <p>The plugin is loaded by `import()` on first use rather than at module scope. Nothing else in
 * this adapter is worth deferring; the point is that a browser bundle which never constructs this
 * class never pulls the plugin in either, which is what the boundary rule buys.</p>
 */
export class TauriSecureStore extends SecureStore {
    /** The keychain (Stronghold / the OS keyring) is doing the protecting, not this process. */
    readonly hardwareBacked = true;

    async getItem(key: string): Promise<string | null> {
        return (await plugin()).secureStorage.getItem(key);
    }

    async setItem(key: string, value: string): Promise<void> {
        await (await plugin()).secureStorage.setItem(key, value);
    }

    async removeItem(key: string): Promise<void> {
        await (await plugin()).secureStorage.removeItem(key);
    }
}

type SecureStoragePlugin = typeof import('tauri-plugin-secure-storage-api');

let loading: Promise<SecureStoragePlugin> | undefined;

/**
 * The plugin module, imported once.
 *
 * <p>A failed import is <b>not</b> memoised. Caching the rejection would turn one bad chunk fetch
 * into a session that can never read a key again - and the caller most likely to hit it is the one
 * storing a master key, which is precisely the operation that must not be permanently poisoned by a
 * transient failure.</p>
 */
function plugin(): Promise<SecureStoragePlugin> {
    loading ??= import('tauri-plugin-secure-storage-api').catch((err: unknown) => {
        loading = undefined;
        throw err;
    });
    return loading;
}
