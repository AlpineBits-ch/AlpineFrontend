/**
 * Small named secrets: signing keys, the wrapped master key, the push token.
 *
 * Keychain-backed on desktop, IndexedDB on web. {@link SecureStore.hardwareBacked} is how the UI
 * says which, so it must never claim a protection the host cannot provide.
 */
export abstract class SecureStore {
    abstract getItem(key: string): Promise<string | null>;

    abstract setItem(key: string, value: string): Promise<void>;

    abstract removeItem(key: string): Promise<void>;

    /** Whether this backend is OS-protected. False on web. Drives the UI warning. */
    abstract readonly hardwareBacked: boolean;

    /** Tail of the {@link update} chain. See there for why one writer is not one caller. */
    private queue: Promise<unknown> = Promise.resolve();

    /**
     * Replaces one entry with a value computed from what is stored right now, with nothing else
     * allowed to write that entry in between.
     *
     * The default only serialises callers within one store instance. `WebSecureStore` must keep
     * overriding it with a Web Lock, because two tabs each hold a store of their own.
     *
     * @param next given the stored value, or `null` when there is no such entry; returning `null`
     *     removes it, and returning the value it was given writes nothing at all. A rejection thrown
     *     from here propagates and leaves the entry untouched.
     * @returns what is stored when the call resolves.
     */
    update(key: string, next: (current: string | null) => string | null): Promise<string | null> {
        // The previous link's failure is swallowed: one rejected update must not poison later ones.
        const result = this.queue.then(
            () => this.applyUpdate(key, next),
            () => this.applyUpdate(key, next),
        );
        this.queue = result.catch(() => undefined);
        return result;
    }

    /** The read-modify-write itself, with no mutual exclusion of its own. Never call it directly. */
    protected async applyUpdate(
        key: string,
        next: (current: string | null) => string | null,
    ): Promise<string | null> {
        const current = await this.getItem(key);
        const value = next(current);
        if (value === current) return current;
        if (value === null) await this.removeItem(key);
        else await this.setItem(key, value);
        return value;
    }
}
