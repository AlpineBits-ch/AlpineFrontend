import {MlsLocalStore, MlsLocalStoreFactory} from '../ports/mls-local-store.port';

/**
 * An in-memory {@link MlsLocalStoreFactory} for specs.
 *
 * <p>Replaces the `vi.mock('@tauri-apps/plugin-store')` stub the MLS specs used to carry, and keeps the
 * one property those specs actually assert: <b>one backing map per file name, shared across `open`
 * calls</b>. That is what lets "did these two accounts read the same file" be a question a test can
 * answer, which is the whole subject of `mls-account-scope.spec.ts` - every local store is named for the
 * account's device id, and two accounts sharing one file is the leak that scoping closed.</p>
 */
export class FakeMlsLocalStoreFactory extends MlsLocalStoreFactory {
    /** File name -> its entries. Public so a spec can seed or inspect a file directly. */
    readonly files = new Map<string, Map<string, unknown>>();

    /** Every file name opened, in order, including repeats. */
    readonly opened: string[] = [];

    open(file: string): MlsLocalStore {
        this.opened.push(file);
        let values = this.files.get(file);
        if (!values) {
            values = new Map<string, unknown>();
            this.files.set(file, values);
        }
        return new FakeMlsLocalStore(values);
    }

    /** Forgets every file. Not a `clear()` on each store - this is the fresh-installation state. */
    reset(): void {
        this.files.clear();
        this.opened.length = 0;
    }
}

class FakeMlsLocalStore implements MlsLocalStore {
    constructor(private readonly values: Map<string, unknown>) {}

    async get<T>(key: string): Promise<T | undefined> {
        return this.values.get(key) as T | undefined;
    }

    async set(key: string, value: unknown): Promise<void> {
        this.values.set(key, value);
    }

    async delete(key: string): Promise<boolean> {
        return this.values.delete(key);
    }

    /**
     * Synchronous between the read and the write, which is the point of it here.
     *
     * <p>A fake that awaited in between would let a spec's other "tab" interleave and would then be
     * modelling the bug rather than the port. The real adapters buy this with a Web Lock (web) and a
     * queue (desktop); nothing in this process can get between these two lines.</p>
     */
    async update<T>(key: string, next: (current: T | undefined) => T | undefined): Promise<T | undefined> {
        const current = this.values.get(key) as T | undefined;
        const value = next(current);
        if (value === current) return current;
        if (value === undefined) this.values.delete(key);
        else this.values.set(key, value);
        return value;
    }

    async entries<T>(): Promise<[string, T][]> {
        return [...this.values.entries()] as [string, T][];
    }

    async clear(): Promise<void> {
        this.values.clear();
    }

    async save(): Promise<void> {
        // Nothing is buffered.
    }
}
