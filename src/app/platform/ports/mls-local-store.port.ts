/**
 * One of MLS's two per-account local files: the group registry, or the plaintext message cache.
 *
 * <p><b>Why this is not {@link SettingsStore}.</b> That interface is deliberately four methods -
 * `get`, `set`, `delete`, `save` - because that is all the settings readers ask of it, and because
 * `LazyStore` satisfies it structurally. These two files need <i>enumeration</i>: `exportBackup` dumps
 * the whole registry into the §D envelope, the message cache is pruned by age across every entry, and
 * both are cleared wholesale by a wipe. `entries()` and `clear()` cannot be expressed over the narrow
 * shape, and the settings port's browser adapter compounds it by ignoring the file name entirely - one
 * `localStorage` namespace for every "file" - so a `clear()` routed through it would take the account
 * registry and the device ids with it.</p>
 *
 * <p>Widening `SettingsStore` and giving its web adapter per-file scoping is the better end state and
 * would delete this port. Until then this is the seam, and it is the <i>only</i> storage path these two
 * files use on either host: on the desktop it is the same two `LazyStore` files under the same two
 * names, so there is no migration and nothing on disk changes.</p>
 */
export interface MlsLocalStore {
    get<T>(key: string): Promise<T | undefined>;

    set(key: string, value: unknown): Promise<void>;

    delete(key: string): Promise<boolean>;

    /** Every entry, in no guaranteed order. */
    entries<T>(): Promise<[string, T][]>;

    /** Drops every entry in this file, and only this file. */
    clear(): Promise<void>;

    /** Flushes, where the backend buffers. A no-op where it writes through. */
    save(): Promise<void>;
}

/**
 * Opens one of MLS's per-account local files for whichever host this bundle is running in.
 *
 * <p>An abstract class rather than an interface plus an `InjectionToken`, so `inject()` needs no
 * separate token - the shape every port here follows. It imports nothing from `../tauri/` or `../web/`,
 * also like every other port: the adapters import the port, never the reverse, and the concrete pair is
 * named in `providePlatform()`, which is the one file allowed to know both sides. An earlier revision
 * had the adapter selection here and died with `Class extends value undefined` - the adapter evaluated
 * its `extends` clause while this module was still initialising, and it broke every spec whose graph
 * reaches `mls.service.ts`, most of which have nothing to do with MLS.</p>
 */
export abstract class MlsLocalStoreFactory {
    /**
     * @param file the store's name. Carries the account's device id, which is the whole of the
     *        account isolation - two accounts never resolve to the same file.
     */
    abstract open(file: string): MlsLocalStore;
}
