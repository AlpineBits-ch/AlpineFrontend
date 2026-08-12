/**
 * Small named secrets - signing keys, the wrapped master key, the push token.
 *
 * <p>Hardware/keychain-backed on desktop (Stronghold / the OS keyring); IndexedDB on web. That is a
 * stated downgrade, not an oversight: a browser has no keychain, so anything kept here is readable
 * by anything running on the origin. {@link SecureStore.hardwareBacked} exists so the key-backup UI
 * can say so rather than implying a protection the host cannot provide - see the Security posture
 * section of the browser-only build design.</p>
 *
 * <p>An abstract class rather than an interface plus an `InjectionToken`, so `inject(SecureStore)`
 * is both the token and the type. Every port in this directory follows that shape.</p>
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
     * Replaces one entry with a value computed from what is stored <i>right now</i>, with nothing else
     * allowed to write that entry in between.
     *
     * <p><b>The path this exists for is `MlsService.localStateKey`</b>, which reads the key the engine
     * state is sealed under and mints one when there is none. As a `getItem` followed by a `setItem`
     * that is a read-modify-write, and two of them racing do not merely lose a write: both callers read
     * absence, both mint a <i>different</i> 32-byte key, and the loser's engine blob is now sealed under
     * a key nothing will ever produce again. That does not present as a storage bug. It presents as
     * `MlsStateUnreadableError` on the next launch, which the boot path answers by wiping the device's
     * group state.</p>
     *
     * <p>Two callers are enough for that on any host - the launch sequence and a retry overlapping is
     * all it takes - so the default below serialises them per store instance. It is <b>not</b> enough on
     * web, where the two callers are two tabs with a store each and a queue in one process cannot see
     * the other: `WebSecureStore` overrides this and holds a Web Lock across the read and the write.</p>
     *
     * @param next given the stored value, or `null` when there is no such entry; returning `null`
     *     removes it, and returning the value it was given writes nothing at all. A rejection thrown
     *     from here propagates and leaves the entry untouched.
     * @returns what is stored when the call resolves.
     */
    update(key: string, next: (current: string | null) => string | null): Promise<string | null> {
        // The previous link's failure is not this call's, so it is swallowed rather than propagated -
        // one rejected update must not poison every later one on this store.
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
