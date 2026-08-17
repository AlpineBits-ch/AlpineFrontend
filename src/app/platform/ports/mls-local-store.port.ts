/** One of MLS's two per-account local files: the group registry, or the plaintext message cache. */
export interface MlsLocalStore {
    get<T>(key: string): Promise<T | undefined>;

    set(key: string, value: unknown): Promise<void>;

    delete(key: string): Promise<boolean>;

    /**
     * Replaces one entry with a value computed from what is stored right now, with nothing else
     * allowed to write this file in between.
     *
     * The read inside must be a read of storage, never of any cache the adapter keeps.
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
 * Must import nothing from `../tauri/` or `../web/`: adapters import the port, never the reverse.
 */
export abstract class MlsLocalStoreFactory {
    /**
     * @param file the store's name. Carries the account's device id, which is the whole of the
     *        account isolation, so two accounts never resolve to the same file.
     */
    abstract open(file: string): MlsLocalStore;
}
