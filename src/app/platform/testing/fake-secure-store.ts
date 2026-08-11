import {SecureStore} from '../ports/secure-store.port';

/**
 * A {@link SecureStore} for specs, provided in TestBed in place of an adapter.
 *
 * <p>This is what the design spec means by "fake adapters for every port": the specs that used to
 * `vi.mock('tauri-plugin-secure-storage-api')` provide one of these instead. The difference is not
 * tidiness - a module mock pins the desktop keychain's behaviour, so the two answers that only the
 * browser adapter gives could not be expressed at all: {@link hardwareBacked} being false, and a
 * write rejecting because there is nowhere to persist it. Those are the paths worth testing, because
 * what is stored here is key material and a caller has to be able to tell that a write did not
 * happen.</p>
 *
 * <p>Stateful, so a write is observable by the next read - which lets a test assert what is in the
 * store rather than which function was called with what.</p>
 */
export class FakeSecureStore extends SecureStore {
    /**
     * What the adapter would report. True by default, standing in for the desktop keychain.
     *
     * <p>Mutable, deliberately: "this host has no keychain" is a one-line thing for a test to say, and
     * anything gating on it - the key-backup warning, `PaymentHandleService.isAvailable()` - deserves
     * a test that says it.</p>
     */
    hardwareBacked = true;

    /** Every key asked for, in order, so a test can pin the *name* an entry is addressed by. */
    readonly reads: string[] = [];

    /**
     * Set to make every {@link getItem} reject.
     *
     * <p>A locked keychain on desktop, or a context with no IndexedDB on web. The distinction the
     * callers make is whether they treat that as "no key" or let it through, and it is worth being
     * able to test both.</p>
     */
    getError: Error | null = null;

    /** Set to make every {@link setItem} reject - a full disk, or storage that refuses to persist. */
    setError: Error | null = null;

    /** Set to make every {@link removeItem} reject, as some backends do for an absent key. */
    removeError: Error | null = null;

    private readonly entries = new Map<string, string>();

    /** Seeds an entry without going through {@link setItem}, and without recording a read. */
    put(key: string, value: string): void {
        this.entries.set(key, value);
    }

    /** Reads an entry without recording a read or honouring {@link getError}. */
    peek(key: string): string | null {
        return this.entries.get(key) ?? null;
    }

    /** Every key currently held, in insertion order. */
    keys(): string[] {
        return [...this.entries.keys()];
    }

    async getItem(key: string): Promise<string | null> {
        this.reads.push(key);
        if (this.getError) throw this.getError;
        return this.entries.get(key) ?? null;
    }

    async setItem(key: string, value: string): Promise<void> {
        if (this.setError) throw this.setError;
        this.entries.set(key, value);
    }

    async removeItem(key: string): Promise<void> {
        if (this.removeError) throw this.removeError;
        this.entries.delete(key);
    }
}
