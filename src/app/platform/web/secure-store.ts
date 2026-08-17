import {SecureStore} from '../ports/secure-store.port';
import {IdbCorruptValueError, IdbStore, IdbStoreClosedError, openStore} from './idb';
import {criticalSectionName, detectLockManager, withWebLock} from './session-lock';

/**
 * The database and object store the browser build keeps its secrets in.
 *
 * <p><b>Persisted names.</b> Once a session has stored a signing key under these, renaming either one
 * makes that key unreachable - which does not present as a storage bug but as this device being
 * silently ejected from every MLS group it belongs to, on a machine that still physically holds the
 * key. Treat them the way `alpine_settings::` is treated in the web settings adapter.</p>
 *
 * <p><b>Its own database, not an object store beside the MLS engine's state blob.</b> {@link openStore}
 * supports sharing a database name, but adding an object store to an existing database is a version
 * change, and a version change closes <i>every other open connection</i> to it - `idb.ts` yields on
 * `versionchange` deliberately, because a blocked upgrade elsewhere is worse than a closed connection
 * here. Sharing would therefore mean that on the first run after either component ships, whichever
 * opened first is silently closed by the other, and that component is the one holding a write it
 * thinks succeeded. A separate database costs nothing and removes the interaction entirely.</p>
 */
const DB_NAME = 'alpine-secure-store';
const STORE_NAME = 'entries';

/**
 * {@link SecureStore} over IndexedDB, for the browser build.
 *
 * <p><b>This is a stated downgrade and the adapter is built to be honest about it.</b> On desktop
 * these entries sit in the OS keychain; here they are ordinary origin-scoped storage holding the MLS
 * signing keys and the wrapped account master key, so any script that runs on the origin can read
 * them. {@link hardwareBacked} is false so the key-backup UI can say so rather than implying a
 * protection the host cannot provide, and a tight Content-Security-Policy on the web deployment is
 * the actual defence - see the Security posture section of the browser-only build design.</p>
 *
 * <p><b>It never degrades.</b> If IndexedDB is missing or unusable - some private-browsing modes, a
 * context with no storage at all - every call rejects with the typed error {@code idb.ts} raised, and
 * nothing falls back to {@code localStorage} or to an in-memory map. A caller that has just generated
 * a master key has to be able to tell "not stored" from "stored somewhere weaker": a silent fallback
 * would hand the user a key they believe is saved and a recovery that cannot work. The rejection is
 * propagated unchanged rather than being wrapped or logged, because {@link IdbStoreError.kind}
 * already distinguishes {@code unavailable} (hopeless) from {@code blocked} and {@code quota}
 * (retryable), and re-wrapping it would throw that away.</p>
 */
export class WebSecureStore extends SecureStore {
    /** No keychain exists in a browser. The one flag the key-backup warning is driven by. */
    readonly hardwareBacked = false;

    /**
     * The open connection, shared by every call.
     *
     * <p>A rejected open is deliberately not kept: `blocked` and `quota` are transient, and a
     * memoised rejection would make the first unlucky boot permanent for the whole session.</p>
     */
    private opening: Promise<IdbStore> | undefined;

    /**
     * @param locks the profile's lock manager. Injectable because jsdom has none, and because two
     *     "tabs" in one spec have to share one manager for {@link update} to be provable at all.
     * @param open opens the entries store. Injectable so a spec can hand in a `fake-indexeddb` factory.
     */
    constructor(
        private readonly locks: LockManager | undefined = detectLockManager(),
        private readonly open: () => Promise<IdbStore> = () => openStore(DB_NAME, STORE_NAME),
    ) {
        super();
    }

    /**
     * The port's read-modify-write, held against every other tab rather than only against this one.
     *
     * <p>The inherited implementation serialises the callers inside one document, which is the whole of
     * the problem on a host with one process and none of it here: two tabs are two `WebSecureStore`s
     * with a queue each, and neither queue can see the other. So the base class's sequence is run
     * inside an exclusive Web Lock named for the entry, and the read that decides is issued after the
     * lock is held.</p>
     *
     * <p>Named per entry rather than per store, so minting the state key does not hold up an unrelated
     * signing-key write. Nothing nests: `applyUpdate` reaches `getItem`/`setItem`, and those take no
     * lock.</p>
     */
    override update(key: string, next: (current: string | null) => string | null): Promise<string | null> {
        return withWebLock(
            criticalSectionName('secure-store', key),
            () => this.applyUpdate(key, next),
            this.locks,
        );
    }

    async getItem(key: string): Promise<string | null> {
        const value = await this.run(store => store.get(key));
        if (value === undefined) {
            return null;
        }
        if (typeof value !== 'string') {
            // Only strings are ever written here, so binary under one of these keys means another
            // component wrote into this object store. Returning it coerced would hand a caller a
            // "key" that is not the one it stored; saying so is the only honest answer.
            throw new IdbCorruptValueError(
                `secure store key "${key}" holds binary data; only strings are stored here, so ` +
                    `something else wrote to "${DB_NAME}"/"${STORE_NAME}"`,
            );
        }
        return value;
    }

    async setItem(key: string, value: string): Promise<void> {
        await this.run(store => store.set(key, value));
    }

    async removeItem(key: string): Promise<void> {
        await this.run(store => store.delete(key));
    }

    /**
     * Runs one operation against the open store, reopening once if the connection has gone.
     *
     * <p>A connection dies when another tab upgrades the database, and {@code idb.ts} answers every
     * later call on it with {@link IdbStoreClosedError} and the instruction to reopen. Without this,
     * one background tab reloading would leave the foreground unable to write a key for the rest of
     * the session - a durability failure that looks like nothing at all until a restore.</p>
     *
     * <p>Exactly one retry, and only for that error. Every operation here is an idempotent get, put
     * or delete, so repeating one cannot half-apply; anything else - {@code quota},
     * {@code unavailable} - is propagated on the first attempt, because retrying it would only delay
     * the honest answer.</p>
     */
    private async run<T>(op: (store: IdbStore) => Promise<T>): Promise<T> {
        try {
            return await op(await this.store());
        } catch (err) {
            if (!(err instanceof IdbStoreClosedError)) {
                throw err;
            }
            this.opening = undefined;
            return await op(await this.store());
        }
    }

    private store(): Promise<IdbStore> {
        this.opening ??= this.open().catch((err: unknown) => {
            this.opening = undefined;
            throw err;
        });
        return this.opening;
    }
}
