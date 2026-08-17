/**
 * A small IndexedDB key-value store for the browser build. Every failure is a typed rejection, no
 * promise may hang, and there is no fallback store.
 */

/** Everything this store accepts and returns. Anything else is a programmer error, not a state. */
export type IdbValue = string | Uint8Array | ArrayBuffer;

/** What went wrong, in the terms a caller can actually act on. */
export type IdbFailureKind =
    | 'unavailable'
    | 'blocked'
    | 'version'
    | 'quota'
    | 'aborted'
    | 'closed'
    | 'corrupt'
    | 'unknown';

/**
 * Base class for every failure this module raises. `name` must be assigned explicitly, not inferred
 * from the class, because minifiers rename classes.
 */
export class IdbStoreError extends Error {
    readonly kind: IdbFailureKind;

    constructor(kind: IdbFailureKind, message: string, cause?: unknown) {
        super(message, cause === undefined ? undefined : {cause});
        this.kind = kind;
        this.name = 'IdbStoreError';
    }
}

/** There is no IndexedDB here. Persistence is unavailable; there is no fallback on purpose. */
export class IdbUnavailableError extends IdbStoreError {
    constructor(message: string, cause?: unknown) {
        super('unavailable', message, cause);
        this.name = 'IdbUnavailableError';
    }
}

/** An upgrade could not proceed because another connection is holding the database open. */
export class IdbBlockedError extends IdbStoreError {
    constructor(message: string, cause?: unknown) {
        super('blocked', message, cause);
        this.name = 'IdbBlockedError';
    }
}

/** The stored database version is incompatible with the one requested. */
export class IdbVersionError extends IdbStoreError {
    constructor(message: string, cause?: unknown) {
        super('version', message, cause);
        this.name = 'IdbVersionError';
    }
}

/** The write did not fit. Storage is full. */
export class IdbQuotaExceededError extends IdbStoreError {
    constructor(message: string, cause?: unknown) {
        super('quota', message, cause);
        this.name = 'IdbQuotaExceededError';
    }
}

/** The transaction rolled back, so nothing it contained was written. */
export class IdbTransactionAbortedError extends IdbStoreError {
    constructor(message: string, cause?: unknown) {
        super('aborted', message, cause);
        this.name = 'IdbTransactionAbortedError';
    }
}

/** This connection is no longer usable. Reopen the store. */
export class IdbStoreClosedError extends IdbStoreError {
    constructor(message: string, cause?: unknown) {
        super('closed', message, cause);
        this.name = 'IdbStoreClosedError';
    }
}

/** A stored key or value has a type this store never writes. */
export class IdbCorruptValueError extends IdbStoreError {
    constructor(message: string, cause?: unknown) {
        super('corrupt', message, cause);
        this.name = 'IdbCorruptValueError';
    }
}

/** The key-value surface. Narrow on purpose: a keychain replacement, not a database. */
export interface IdbStore {
    readonly dbName: string;
    readonly storeName: string;

    /** The stored value, or {@code undefined} when the key is absent. A stored `''` reads back as `''`. */
    get(key: string): Promise<IdbValue | undefined>;

    /** Writes {@code value} under {@code key}, replacing anything already there. */
    set(key: string, value: IdbValue): Promise<void>;

    /** Removes {@code key}. Resolves whether or not it existed, as IndexedDB does. */
    delete(key: string): Promise<void>;

    /** Every key present, in ascending key order. */
    keys(): Promise<string[]>;

    /** Removes everything in this object store. */
    clear(): Promise<void>;

    /** Releases the connection. Later operations reject with {@link IdbStoreClosedError}. */
    close(): void;
}

export interface OpenStoreOptions {
    /** The {@link IDBFactory} to use. Defaults to {@code globalThis.indexedDB}. */
    factory?: IDBFactory;

    /**
     * Pin an explicit database version. Omit it, and the default opens whatever version exists and
     * adds the object store with a one-step upgrade only if it is missing.
     */
    version?: number;

    /**
     * How long to wait for other connections to release a database before rejecting with
     * {@link IdbBlockedError}. Defaults to 5s. Never waits indefinitely.
     */
    blockedTimeoutMs?: number;
}

const DEFAULT_BLOCKED_TIMEOUT_MS = 5_000;

const tagOf = (value: unknown): string => Object.prototype.toString.call(value);

/** Whether {@code value} is a type this store round-trips without loss. Brand checks, not `instanceof`. */
export function isIdbValue(value: unknown): value is IdbValue {
    if (typeof value === 'string') {
        return true;
    }
    const tag = tagOf(value);
    return tag === '[object Uint8Array]' || tag === '[object ArrayBuffer]';
}

/**
 * Returns {@code value} as a binary object belonging to this realm, or {@code undefined} if it is
 * not binary at all. A foreign-realm value is copied so callers using `instanceof` still work.
 */
const localizeBinary = (value: unknown): Uint8Array | ArrayBuffer | undefined => {
    const tag = tagOf(value);
    if (tag === '[object Uint8Array]') {
        if (value instanceof Uint8Array) {
            return value;
        }
        const foreign = value as ArrayLike<number> & {byteLength: number};
        const copy = new Uint8Array(foreign.byteLength);
        copy.set(foreign);
        return copy;
    }
    if (tag === '[object ArrayBuffer]') {
        if (value instanceof ArrayBuffer) {
            return value;
        }
        const foreign = value as ArrayBuffer;
        const copy = new ArrayBuffer(foreign.byteLength);
        new Uint8Array(copy).set(new Uint8Array(foreign));
        return copy;
    }
    return undefined;
};

const describeType = (value: unknown): string => {
    if (value === null) {
        return 'null';
    }
    if (typeof value !== 'object') {
        return typeof value;
    }
    return tagOf(value).slice(8, -1);
};

const errorName = (error: unknown): string | undefined => {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }
    const name: unknown = (error as {name?: unknown}).name;
    return typeof name === 'string' ? name : undefined;
};

const errorDetail = (error: unknown): string => {
    const name = errorName(error);
    const message = typeof error === 'object' && error !== null
        ? (error as {message?: unknown}).message
        : undefined;
    if (name !== undefined && typeof message === 'string' && message.length > 0) {
        return `${name}: ${message}`;
    }
    return name ?? String(error);
};

/**
 * Maps a raw IndexedDB failure onto {@link IdbStoreError}, by {@code DOMException.name}: the only
 * part of an IndexedDB error that is specified.
 *
 * @internal Exported for tests. Not part of the store's contract.
 */
export function classifyIdbError(
    error: unknown,
    context: string,
    fallback: IdbFailureKind = 'unknown',
): IdbStoreError {
    if (error instanceof IdbStoreError) {
        return error;
    }
    const detail = errorDetail(error);
    switch (errorName(error)) {
        case 'QuotaExceededError':
            return new IdbQuotaExceededError(`${context}: storage quota exceeded (${detail})`, error);
        case 'VersionError':
            return new IdbVersionError(
                `${context}: the stored database is at a different version - another tab has ` +
                `probably upgraded it, so this page needs to reload (${detail})`,
                error,
            );
        case 'AbortError':
            return new IdbTransactionAbortedError(`${context}: transaction aborted (${detail})`, error);
        case 'InvalidStateError':
            return new IdbStoreClosedError(
                `${context}: the database connection is closed (${detail})`,
                error,
            );
        default:
            break;
    }
    if (fallback === 'aborted') {
        return new IdbTransactionAbortedError(`${context}: transaction aborted (${detail})`, error);
    }
    return new IdbStoreError(fallback, `${context}: ${detail}`, error);
}

const isFactory = (candidate: unknown): candidate is IDBFactory =>
    candidate !== null
    && candidate !== undefined
    && typeof (candidate as IDBFactory).open === 'function';

const resolveFactory = (explicit?: IDBFactory): IDBFactory | undefined => {
    // An explicitly supplied factory is validated too, or a bad stub fails later with a TypeError.
    if (explicit !== undefined) {
        return isFactory(explicit) ? explicit : undefined;
    }
    // Reading the property itself throws in some private-browsing modes, so this is not paranoia.
    let candidate: unknown;
    try {
        candidate = (globalThis as {indexedDB?: unknown}).indexedDB;
    } catch {
        return undefined;
    }
    return isFactory(candidate) ? candidate : undefined;
};

/** Whether IndexedDB exists in this context at all. Only {@link openStore} proves a write can succeed. */
export function isIndexedDbAvailable(factory?: IDBFactory): boolean {
    return resolveFactory(factory) !== undefined;
}

/**
 * Runs one request inside its own transaction and resolves only once that transaction commits. All
 * three terminal transaction events must stay handled, or the promise can hang forever.
 *
 * @internal Exported so tests can drive the abort path, which no public method can trigger on
 *     itself. Not part of the store's contract.
 */
export function runRequest<T>(
    db: IDBDatabase,
    storeName: string,
    mode: IDBTransactionMode,
    exec: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const context = `${mode} transaction on "${storeName}"`;
        let transaction: IDBTransaction;
        try {
            transaction = db.transaction(storeName, mode);
        } catch (error) {
            reject(classifyIdbError(error, context));
            return;
        }

        let request: IDBRequest;
        try {
            request = exec(transaction.objectStore(storeName));
        } catch (error) {
            // A synchronous throw here leaves the transaction open, so it must be aborted.
            try {
                transaction.abort();
            } catch {
                // Already finished. Nothing to undo.
            }
            reject(classifyIdbError(error, context));
            return;
        }

        let result: T | undefined;
        let requestError: unknown;
        request.onsuccess = () => {
            result = request.result as T;
        };
        request.onerror = () => {
            // Must not call preventDefault(): the error has to bubble so the transaction aborts.
            requestError = request.error;
        };

        transaction.oncomplete = () => resolve(result as T);
        transaction.onerror = () => reject(
            classifyIdbError(transaction.error ?? requestError, context),
        );
        transaction.onabort = () => reject(
            classifyIdbError(transaction.error ?? requestError, context, 'aborted'),
        );
    });
}

const openDatabase = (
    factory: IDBFactory,
    dbName: string,
    storeName: string,
    version: number | undefined,
    blockedTimeoutMs: number,
): Promise<IDBDatabase> => new Promise<IDBDatabase>((resolve, reject) => {
    const context = `opening database "${dbName}"`;
    let request: IDBOpenDBRequest;
    try {
        request = version === undefined ? factory.open(dbName) : factory.open(dbName, version);
    } catch (error) {
        // Some private-browsing modes throw right here; that is unavailability, not a transient error.
        reject(new IdbUnavailableError(
            `${context} threw synchronously; IndexedDB is not usable in this context ` +
            `(${errorDetail(error)})`,
            error,
        ));
        return;
    }

    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    let abandoned = false;
    const clearBlockedTimer = () => {
        if (blockedTimer !== undefined) {
            clearTimeout(blockedTimer);
            blockedTimer = undefined;
        }
    };

    request.onblocked = () => {
        if (blockedTimer !== undefined || abandoned) {
            return;
        }
        // The wait must stay bounded: the spec leaves the request pending until other tabs close.
        blockedTimer = setTimeout(() => {
            blockedTimer = undefined;
            abandoned = true;
            reject(new IdbBlockedError(
                `${context}: upgrade to version ${version ?? '(current)'} is blocked by another ` +
                `open connection - another tab is holding an older version of this database`,
            ));
        }, blockedTimeoutMs);
    };

    request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName);
        }
    };

    request.onsuccess = () => {
        clearBlockedTimer();
        const db = request.result;
        if (abandoned) {
            // Must close: a leaked connection here is what blocks the next tab.
            db.close();
            return;
        }
        resolve(db);
    };

    request.onerror = () => {
        clearBlockedTimer();
        if (abandoned) {
            return;
        }
        reject(classifyIdbError(request.error, context));
    };
});

class IdbKeyValueStore implements IdbStore {
    private closedReason: string | undefined;

    constructor(
        readonly dbName: string,
        readonly storeName: string,
        private readonly db: IDBDatabase,
    ) {
        db.onversionchange = () => {
            // Must close, or another tab's upgrade is blocked indefinitely.
            this.closedReason = 'another tab upgraded the database';
            db.close();
        };
        db.onclose = () => {
            this.closedReason ??= 'the browser closed the database connection';
        };
    }

    get(key: string): Promise<IdbValue | undefined> {
        return this
            .run<unknown>('readonly', store => store.get(key))
            .then(value => {
                if (value === undefined) {
                    return undefined;
                }
                if (typeof value === 'string') {
                    return value;
                }
                const binary = localizeBinary(value);
                if (binary === undefined) {
                    throw new IdbCorruptValueError(
                        `"${this.dbName}"/"${this.storeName}" key "${key}" holds a ` +
                        `${describeType(value)}; this store only writes string, Uint8Array and ` +
                        `ArrayBuffer, so something else wrote it`,
                    );
                }
                return binary;
            });
    }

    set(key: string, value: IdbValue): Promise<void> {
        if (!isIdbValue(value)) {
            // A rejection rather than a synchronous throw, so callers have one failure channel.
            return Promise.reject(new TypeError(
                `IdbStore.set("${key}"): value must be a string, Uint8Array or ArrayBuffer, got ` +
                `${describeType(value)}`,
            ));
        }
        // No await before the transaction is created: creation order is what orders concurrent sets.
        return this.run<unknown>('readwrite', store => store.put(value, key)).then(() => undefined);
    }

    delete(key: string): Promise<void> {
        return this.run<unknown>('readwrite', store => store.delete(key)).then(() => undefined);
    }

    keys(): Promise<string[]> {
        return this.run<IDBValidKey[]>('readonly', store => store.getAllKeys()).then(keys => {
            const offender = keys.find(key => typeof key !== 'string');
            if (offender !== undefined) {
                throw new IdbCorruptValueError(
                    `"${this.dbName}"/"${this.storeName}" contains a non-string key ` +
                    `(${describeType(offender)}); this store only writes string keys`,
                );
            }
            return keys as string[];
        });
    }

    clear(): Promise<void> {
        return this.run<unknown>('readwrite', store => store.clear()).then(() => undefined);
    }

    close(): void {
        this.closedReason ??= 'the store was closed by the application';
        this.db.close();
    }

    private run<T>(mode: IDBTransactionMode, exec: (store: IDBObjectStore) => IDBRequest): Promise<T> {
        if (this.closedReason !== undefined) {
            return Promise.reject(new IdbStoreClosedError(
                `"${this.dbName}"/"${this.storeName}" is unusable: ${this.closedReason}. ` +
                `Reopen the store.`,
            ));
        }
        return runRequest<T>(this.db, this.storeName, mode, exec);
    }
}

/**
 * Opens (creating if needed) {@code storeName} in {@code dbName} and returns a key-value view of it.
 * Two stores in one database name cost a reopen, so prefer one database name per consumer.
 *
 * @throws IdbUnavailableError when IndexedDB is absent or unusable.
 * @throws IdbBlockedError when an upgrade is blocked past the timeout.
 * @throws IdbVersionError when the stored version is incompatible.
 */
export async function openStore(
    dbName: string,
    storeName: string,
    options: OpenStoreOptions = {},
): Promise<IdbStore> {
    const factory = resolveFactory(options.factory);
    if (factory === undefined) {
        throw new IdbUnavailableError(
            `cannot open "${dbName}"/"${storeName}": this context has no IndexedDB, so nothing ` +
            `can be persisted. There is deliberately no localStorage fallback for key material.`,
        );
    }

    const blockedTimeoutMs = options.blockedTimeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS;
    let db = await openDatabase(factory, dbName, storeName, options.version, blockedTimeoutMs);

    if (!db.objectStoreNames.contains(storeName)) {
        if (options.version !== undefined) {
            db.close();
            throw new IdbVersionError(
                `"${dbName}" version ${options.version} has no object store "${storeName}", and ` +
                `an explicit version was pinned so it cannot be added`,
            );
        }
        // A sibling store created the database; adding an object store needs a version change.
        const nextVersion = db.version + 1;
        db.close();
        db = await openDatabase(factory, dbName, storeName, nextVersion, blockedTimeoutMs);
        if (!db.objectStoreNames.contains(storeName)) {
            db.close();
            throw new IdbStoreError(
                'unknown',
                `"${dbName}" was upgraded to version ${nextVersion} but object store ` +
                `"${storeName}" still does not exist`,
            );
        }
    }

    return new IdbKeyValueStore(dbName, storeName, db);
}
