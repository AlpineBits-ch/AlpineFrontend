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

    /**
     * Replaces one entry with a value computed from what is stored <i>right now</i>, with nothing else
     * allowed to write this file in between.
     *
     * <p><b>Why this is a store operation and not a `get` followed by a `set`.</b> A browser runs one of
     * these stores per tab, and the two writers that matter here are two tabs of one account. Between a
     * `get` and its `set` the other tab can complete a whole read-modify-write of its own, so the second
     * write lands on a value the first has already moved past and the first tab's decision is silently
     * undone. The path that turns that into a security failure is `MlsService.raiseEncryptionFloor`:
     * interleaved, the lower generation wins, `ctx#floor` goes <b>backwards</b>, and a floor below a
     * generation this device has encrypted at is exactly what licenses composing cleartext into an
     * encrypted conversation (§L.9). The floor is monotonic by construction or it is not monotonic at
     * all.</p>
     *
     * <p>The read inside is a read of storage, not of any cache the adapter keeps, which is the second
     * half of the same guarantee: the web adapter mirrors the file in memory for `entries()`, and a
     * mirror populated before the other tab's write would make the comparison here decide from a value
     * that is no longer there.</p>
     *
     * @param next given the stored value, or `undefined` when there is none; returning `undefined`
     *     deletes the entry, and returning the value it was given writes nothing at all.
     * @returns what is stored when the call resolves.
     */
    update<T>(key: string, next: (current: T | undefined) => T | undefined): Promise<T | undefined>;

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
