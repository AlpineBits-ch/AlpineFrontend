/** One live MLS engine per account scope per browser profile, over the Web Locks API. */

/** What a tab is allowed to do with the engine for one scope. */
export type SessionClaim =
    /** This tab owns the scope. It may read, mutate and persist. */
    | 'held'
    /** Another tab owns it. This tab must not touch the engine; the request stays queued. */
    | 'blocked'
    /** There is no Web Locks API here, so ownership cannot be established at all. See the adapter. */
    | 'unsupported';

/** {@link SessionClaim} plus the state before anything has been claimed. For reporting only. */
export type SessionState = SessionClaim | 'unclaimed';

/** Namespace for every lock this app takes, so nothing collides with a library's. */
const LOCK_PREFIX = 'venta';

/** The session guard's own namespace, one name per account scope. */
const SESSION_LOCK_PREFIX = `${LOCK_PREFIX}:mls-session`;

/** The lock name for one account scope. An absent scope gets its own name, never an account's. */
export function sessionLockName(scope: string | undefined): string {
    return `${SESSION_LOCK_PREFIX}::${scope ?? 'unscoped'}`;
}

/**
 * The lock name for one cross-tab critical section, guarding read-modify-writes on shared IndexedDB.
 * Must stay a different namespace from {@link sessionLockName}, which is held for the tab's life.
 *
 * @param area    the subsystem, so two adapters cannot collide on one subject name.
 * @param subject the thing being guarded: a store file, or one entry's key.
 */
export function criticalSectionName(area: string, subject: string): string {
    return `${LOCK_PREFIX}:${area}::${subject}`;
}

/**
 * Runs `body` with `name` held exclusively across every tab of this profile. Never nest two of these
 * on one name: the Web Locks API has no re-entrancy, so a nested request deadlocks with no timeout.
 */
export async function withWebLock<T>(
    name: string,
    body: () => Promise<T>,
    locks: LockManager | undefined = detectLockManager(),
): Promise<T> {
    if (locks === undefined) return await body();
    // The generic must be left to inference: pinning `T` rejects the async callback.
    return await locks.request(name, {mode: 'exclusive'}, () => body());
}

/** Exclusive ownership of one scope, for as long as this tab lives. */
export interface SessionLock {
    /** The lock name. Read by the adapter to notice that the scope changed under it. */
    readonly name: string;

    /** Whether this tab owns the scope right now. */
    readonly held: boolean;

    /** Whether a request is waiting in the browser's queue for this name. */
    readonly queueing: boolean;

    /**
     * Takes the lock if it is free now. Must never wait on the other tab and must never reject: a
     * failed lock manager is reported as `unsupported`.
     */
    claim(): Promise<SessionClaim>;

    /** What this lock last established, without attempting anything. For the UI and the log. */
    readonly state: SessionState;

    /** Called when a queued request is granted, which is the takeover. Never for an `ifAvailable` grant. */
    onGranted(listener: () => void): void;

    /**
     * Gives up this scope: releases the lock if it is held, and drops the request if it is queued.
     * Dropping the queued request is not optional, or an abandoned lease still wins the lock later.
     */
    release(): void;
}

export type SessionLockFactory = (name: string) => SessionLock;

/** `navigator.locks`, or `undefined` where there is none. Shape-checked, so a partial polyfill fails here. */
export function detectLockManager(): LockManager | undefined {
    let candidate: unknown;
    try {
        candidate = (globalThis as {navigator?: {locks?: unknown}}).navigator?.locks;
    } catch {
        return undefined;
    }
    if (candidate === null || typeof candidate !== 'object') return undefined;
    return typeof (candidate as LockManager).request === 'function' ? (candidate as LockManager) : undefined;
}

/** {@link SessionLock} over `navigator.locks`. */
export class WebLocksSessionLock implements SessionLock {
    private readonly locks: LockManager | undefined;

    private owned = false;

    /** A request is waiting in the browser's queue for this name. Granting it is the takeover. */
    private queued = false;

    /** Resolving this releases the lock. Undefined unless this tab owns it. */
    private releaseHeld: (() => void) | undefined;

    /** Aborts the queued request. Undefined unless one is queued. */
    private dropQueued: AbortController | undefined;

    /** The in-flight {@link claim}, so two concurrent commands cannot race each other's probe. */
    private pending: Promise<SessionClaim> | undefined;

    private established: SessionState = 'unclaimed';

    /** Notified when a queued request is granted. See {@link SessionLock.onGranted}. */
    private readonly granted = new Set<() => void>();

    constructor(
        readonly name: string,
        locks: LockManager | undefined = detectLockManager(),
    ) {
        this.locks = locks;
    }

    get held(): boolean {
        return this.owned;
    }

    get state(): SessionState {
        return this.owned ? 'held' : this.established;
    }

    get queueing(): boolean {
        return this.queued;
    }

    async claim(): Promise<SessionClaim> {
        if (this.locks === undefined) return (this.established = 'unsupported');
        if (this.owned) return 'held';
        // Already in the queue: asking again would only queue behind our own request.
        if (this.queued) return 'blocked';
        // Shared, so two commands issued at once do not both probe and block each other.
        return await (this.pending ??= this.attempt());
    }

    onGranted(listener: () => void): void {
        this.granted.add(listener);
    }

    release(): void {
        const release = this.releaseHeld;
        const drop = this.dropQueued;
        this.forget();
        release?.();
        // Must abort: a queued request outlives the lease that made it and would still be granted.
        drop?.abort();
    }

    private async attempt(): Promise<SessionClaim> {
        try {
            let free: boolean;
            try {
                free = await this.request(true);
            } catch {
                // Must report unsupported rather than raise: this runs inside `mls_init_storage`,
                // whose rejection the boot path answers by wiping local MLS state.
                return (this.established = 'unsupported');
            }
            if (free) return (this.established = 'held');

            // Queued with no timeout, and never awaited; the grant is what performs the takeover.
            this.queued = true;
            const drop = new AbortController();
            this.dropQueued = drop;
            void this.request(false, drop.signal).catch(() => {
                // Never granted: aborted by `release`, or the lock manager failed.
                this.queued = false;
                if (this.dropQueued === drop) this.dropQueued = undefined;
            });
            return (this.established = 'blocked');
        } finally {
            this.pending = undefined;
        }
    }

    /** One `navigator.locks.request`, resolving `true` when the lock is granted, not when released. */
    private request(ifAvailable: boolean, signal?: AbortSignal): Promise<boolean> {
        const locks = this.locks;
        if (locks === undefined) return Promise.resolve(false);

        return new Promise<boolean>((granted, failed) => {
            let settled = false;
            const answer = (value: boolean) => {
                if (settled) return;
                settled = true;
                granted(value);
            };

            const outcome = locks.request<void>(
                this.name,
                // `ifAvailable` and `signal` are mutually exclusive in the API; pass only one.
                ifAvailable ? {mode: 'exclusive', ifAvailable: true} : {mode: 'exclusive', signal},
                (lock): Promise<void> | undefined => {
                    // `ifAvailable` with the lock taken: the callback runs with null and nothing is held.
                    if (lock === null) {
                        answer(false);
                        return undefined;
                    }
                    // Must be read before it is cleared: only a queued grant is a takeover.
                    const takeover = this.queued;
                    this.owned = true;
                    this.queued = false;
                    // Granted, so there is nothing queued left to abort.
                    this.dropQueued = undefined;
                    this.established = 'held';
                    answer(true);
                    if (takeover) this.announce();
                    return new Promise<void>(release => {
                        this.releaseHeld = release;
                    });
                },
            );

            outcome.then(
                () => {
                    // The callback's promise settled, so the lock is gone.
                    this.forget();
                    answer(false);
                },
                (err: unknown) => {
                    this.forget();
                    if (settled) return;
                    settled = true;
                    failed(err);
                },
            );
        });
    }

    /**
     * Tells the listeners the takeover happened. Must run in a microtask, outside the lock callback's
     * frame, or a listener taking a lock deadlocks and a throwing one releases the new lock.
     */
    private announce(): void {
        for (const listener of [...this.granted]) {
            queueMicrotask(() => {
                try {
                    listener();
                } catch (err) {
                    console.error('A session-takeover listener threw', err);
                }
            });
        }
    }

    private forget(): void {
        this.owned = false;
        this.releaseHeld = undefined;
        if (this.established === 'held') this.established = 'unclaimed';
    }
}
