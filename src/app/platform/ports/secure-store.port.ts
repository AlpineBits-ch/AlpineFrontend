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
}
