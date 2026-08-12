/**
 * One live MLS engine per account scope per browser profile.
 *
 * <p><b>The bug this exists to close.</b> On the desktop there is one process and one `MlsState`. In a
 * browser, two tabs of the same account each hold their own in-memory engine and each exports it to the
 * same IndexedDB blob (`state::${scope}`) after every mutating command, so the last writer wins and one
 * tab's group membership, sender-ratchet generations and pending commits are silently overwritten by
 * the other's older snapshot. Worse than the storage race: two live engines on one MLS leaf reuse
 * sender-ratchet generations, which openmls reads as a replay - at least one of them becomes unable to
 * send at all - and voids forward secrecy for that leaf. It is the same hazard
 * `DeviceIdentityService.adopt` warns about for two devices on one leaf, arrived at from a direction no
 * device-id check can see, because both tabs *are* the same device.</p>
 *
 * <h3>Why the Web Locks API and not a heartbeat</h3>
 *
 * <p>A `localStorage` heartbeat cannot promise release. A tab that crashes, is killed by the OS for
 * memory, or is closed while the machine suspends leaves its last heartbeat behind, and every scheme
 * built on that has to guess a timeout - too short and it hands the engine to a second tab while the
 * first is alive (the exact corruption), too long and a crashed tab locks the user out for a minute.
 * A Web Lock is released by the browser when the holding tab goes away, whatever way it goes away, and
 * the queue behind it is granted in order. That is the entire reason this is not a timestamp in
 * `localStorage`.</p>
 *
 * <p>The lock is held for the tab's whole life - `request` is given a callback that returns a promise
 * nothing resolves - so "held" and "this tab owns the engine" are the same fact, with no lease to
 * renew.</p>
 *
 * <h3>Scope, not origin</h3>
 *
 * <p>The name carries the account scope, so two accounts in one profile - two device ids, two blobs -
 * do not lock each other out. That mirrors `state::${scope}`, which is the whole of the cross-account
 * isolation on this host.</p>
 */

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

/**
 * The lock name for one account scope.
 *
 * <p>An absent scope gets its own name rather than sharing an account's, for the reason
 * `WebMlsEngine.blobKey` gives: a shared name is how two accounts came to hold one state file.</p>
 */
export function sessionLockName(scope: string | undefined): string {
    return `${SESSION_LOCK_PREFIX}::${scope ?? 'unscoped'}`;
}

/**
 * The lock name for one cross-tab critical section, in the same namespace as the session lock.
 *
 * <p><b>Why the storage adapters take locks at all, when the session guard already exists.</b> That
 * guard owns the <i>engine</i>: one live `MlsState` per scope, one writer of `state::${scope}`. It says
 * nothing about the two IndexedDB databases beside it - the secure store and the MLS local stores - and
 * both are still written by every tab. Per-key writes there survive that, because a browser serialises
 * overlapping IndexedDB `readwrite` transactions and each key is written whole. What does not survive is
 * a <b>read-modify-write</b>: two tabs read the same value, both decide from it, and the second write
 * lands on a state the first has already moved. Two of those are live and neither is cosmetic:</p>
 * <ul>
 *   <li>`MlsService.raiseEncryptionFloor` reads `ctx#floor`, compares, writes. Interleaved, the lower
 *       generation wins and <b>the floor goes backwards</b> - which is the one thing it exists to make
 *       impossible, because a floor below a generation this device has encrypted at is what licenses
 *       `ChannelComponent.send` to compose cleartext into an encrypted conversation (§L.9).</li>
 *   <li>`MlsService.localStateKey` reads the sealing key and mints one if it is absent. Two tabs booting
 *       together both read absence and both mint, and the loser's key is overwritten - so the engine
 *       blob that tab sealed can never be opened again, which presents as `MlsStateUnreadableError` and
 *       is answered by wiping the device's group state.</li>
 * </ul>
 *
 * <p>Deliberately a <i>different</i> name from {@link sessionLockName}. These sections are held for one
 * operation, the session lock is held for the tab's life, and sharing a name would mean the first
 * registry read in a blocked tab waited for the other tab to close.</p>
 *
 * @param area    the subsystem, so two adapters cannot collide on one subject name.
 * @param subject the thing being guarded: a store file, or one entry's key.
 */
export function criticalSectionName(area: string, subject: string): string {
    return `${LOCK_PREFIX}:${area}::${subject}`;
}

/**
 * Runs `body` with `name` held exclusively across every tab of this profile.
 *
 * <p>Unlike {@link SessionLock.claim} this <b>waits</b>, and that is the right choice here for the
 * reason it is the wrong one there: a session lock is held for a tab's whole life, so waiting on it is
 * waiting for a person to close a window, while one of these is held for a single read-modify-write and
 * is always released - by the callback settling, or by the browser when the holding tab goes away.</p>
 *
 * <p><b>Never nest two of these on one name</b>, in either direction: the Web Locks API has no
 * re-entrancy and a nested request queues behind the outer holder, which is a deadlock with no timeout.
 * Every caller here takes the lock once, at the top of a public method, and the helpers below it take
 * none.</p>
 *
 * <p><b>No lock manager means the body still runs.</b> That is not the fail-closed posture
 * {@link MlsSessionGuardUnavailableError} takes and the difference is deliberate: on such a host the
 * engine refuses every command, so no group is created, no floor is ever raised and there is no
 * read-modify-write left to lose. Refusing here would instead take down the reads that report the
 * refusal and the wipe that a sign-out performs, which is a real cost for no protection.</p>
 */
export async function withWebLock<T>(
    name: string,
    body: () => Promise<T>,
    locks: LockManager | undefined = detectLockManager(),
): Promise<T> {
    if (locks === undefined) return await body();
    // The generic is left to inference on purpose. `LockGrantedCallback<T>` is typed as returning `T`
    // rather than `T | PromiseLike<T>`, so pinning `T` here would reject the async callback the API is
    // actually specified to await; inferred, `T` becomes `Promise<T>` and the `await` unwraps both.
    return await locks.request(name, {mode: 'exclusive'}, () => body());
}

/**
 * Exclusive ownership of one scope, for as long as this tab lives.
 *
 * <p>An interface so the adapter can be handed a fake; the only implementation on a real host is
 * {@link WebLocksSessionLock}.</p>
 */
export interface SessionLock {
    /** The lock name. Read by the adapter to notice that the scope changed under it. */
    readonly name: string;

    /** Whether this tab owns the scope right now. */
    readonly held: boolean;

    /**
     * Whether a request is waiting in the browser's queue for this name.
     *
     * <p>Reported so a caller can tell "asked and was refused" from "never asked", and so a spec can
     * prove that giving up a scope really does leave the queue empty.</p>
     */
    readonly queueing: boolean;

    /**
     * Takes the lock if it is free <i>now</i>.
     *
     * <p><b>Never waits on the other tab.</b> This is called from the boot path, and a promise that
     * waits there is a blank screen for as long as the other tab stays open - which could be days.
     * So the first attempt is `ifAvailable`, and when it comes back `blocked` a second request is
     * left <b>queued with no timeout</b>: that is what makes a takeover automatic. Close the owning
     * tab and this one is granted the lock by the browser, so the next call sees `held` without a
     * reload.</p>
     *
     * <p>That is also why there is no timeout here, unlike `openStore`'s bounded wait for a blocked
     * upgrade. The only request that can wait is the queued one, and it is never awaited; an
     * `ifAvailable` request is answered without regard to other tabs, so nothing on this path can
     * hang on one. A timeout would be actively harmful: concluding "unsupported" while a request is
     * still pending would leave this tab holding a scope it believes it does not have.</p>
     *
     * <p>Never rejects. A lock manager that fails to answer is reported as `unsupported`, because this
     * runs inside `mls_init_storage`, whose rejection is what the boot path answers with a wipe.</p>
     */
    claim(): Promise<SessionClaim>;

    /** What this lock last established, without attempting anything. For the UI and the log. */
    readonly state: SessionState;

    /**
     * Called when a <b>queued</b> request is granted, which is the takeover and nothing else.
     *
     * <p>Deliberately not called for the `ifAvailable` grant on the boot path. That one is the ordinary
     * first claim, and a listener that could not tell the two apart would run the whole launch sequence
     * a second time on every cold start.</p>
     *
     * <p>Listeners run in a microtask rather than inside the browser's lock callback, so a listener is
     * free to take another lock without deadlocking against the frame that granted this one.</p>
     */
    onGranted(listener: () => void): void;

    /**
     * Gives up this scope: releases the lock if it is held, and drops the request if it is queued.
     *
     * <p>For a scope change and for tests; a closing tab needs no help. <b>Dropping the queued request
     * is not optional.</b> A lease abandoned while queued would still be granted the lock later, and its
     * callback holds forever - so the tab would own a scope nothing in it is using and lock every other
     * tab out of that account for as long as it stays open.</p>
     */
    release(): void;
}

export type SessionLockFactory = (name: string) => SessionLock;

/**
 * `navigator.locks`, or `undefined` where there is none.
 *
 * <p>Absent in a non-secure context and in browsers older than Chrome 69 / Firefox 96 / Safari 15.4.
 * Read through a `try` because touching `navigator` sub-objects throws in some hardened embeddings,
 * and shape-checked rather than trusted, so a partial polyfill reports unsupported instead of failing
 * later inside a request.</p>
 */
export function detectLockManager(): LockManager | undefined {
    let candidate: unknown;
    try {
        candidate = (globalThis as {navigator?: {locks?: unknown}}).navigator?.locks;
    } catch {
        return undefined;
    }
    if (candidate === null || typeof candidate !== 'object') return undefined;
    return typeof (candidate as LockManager).request === 'function'
        ? candidate as LockManager
        : undefined;
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

    constructor(readonly name: string, locks: LockManager | undefined = detectLockManager()) {
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
        if (this.locks === undefined) return this.established = 'unsupported';
        if (this.owned) return 'held';
        // Already in the queue: asking again would only queue behind our own request. The takeover
        // arrives through that request, not through another probe.
        if (this.queued) return 'blocked';
        // Shared, so two commands issued at once do not both probe - the second probe would find the
        // lock taken by the first and report this tab blocked by itself.
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
        // A queued request outlives the lease that made it unless it is aborted, and would then be
        // granted to a tab that has moved on - holding the scope against every other tab for nothing.
        drop?.abort();
    }

    private async attempt(): Promise<SessionClaim> {
        try {
            let free: boolean;
            try {
                free = await this.request(true);
            } catch {
                // The lock manager exists and would not answer - a partial implementation, or a context
                // that rejects the request outright. Reported as unsupported rather than raised, and
                // that is not tidiness: this runs inside `mls_init_storage`, whose rejection is what
                // the boot path answers by wiping local MLS state. Failing closed here costs a refusal;
                // failing loudly here could cost the user their group keys.
                return this.established = 'unsupported';
            }
            if (free) return this.established = 'held';

            // Queued with no timeout and deliberately not awaited. When the owning tab goes away the
            // browser grants this, `owned` flips, and the next command proceeds - which is the whole
            // of the takeover.
            this.queued = true;
            const drop = new AbortController();
            this.dropQueued = drop;
            void this.request(false, drop.signal).catch(() => {
                // Never granted - aborted by `release`, or the lock manager failed. Let a later claim
                // try again rather than reporting a queue position that does not exist.
                this.queued = false;
                if (this.dropQueued === drop) this.dropQueued = undefined;
            });
            return this.established = 'blocked';
        } finally {
            this.pending = undefined;
        }
    }

    /**
     * One `navigator.locks.request`, resolving `true` <b>at the moment the lock is granted</b> rather
     * than when it is released.
     *
     * <p>That inversion is the crux of holding a lock for a session's lifetime: `request` resolves
     * only once its callback's promise settles, so a caller that awaits `request` directly can never
     * both hold the lock and know that it does. So the grant is reported out of the callback and the
     * callback returns a promise that only {@link release} - or the tab ending - settles.</p>
     */
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
                // `ifAvailable` and `signal` are mutually exclusive in the API - a request that never
                // waits has nothing to abort - so only one of them is ever passed.
                ifAvailable ? {mode: 'exclusive', ifAvailable: true} : {mode: 'exclusive', signal},
                (lock): Promise<void> | undefined => {
                    // `ifAvailable` with the lock taken: the callback runs with null and nothing is
                    // held. The only "no" this API gives.
                    if (lock === null) {
                        answer(false);
                        return undefined;
                    }
                    // Read before it is cleared: a grant that was waiting in the queue is a takeover -
                    // the other tab is gone - and an `ifAvailable` grant is an ordinary first claim.
                    // Only the first has a launch sequence owing to it.
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
                    // The callback's promise settled, so the lock is gone. Either `release()` was
                    // called or the browser took it back.
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
     * Tells the listeners the takeover happened, out of the lock callback's own frame.
     *
     * <p>A microtask rather than a direct call for two reasons. The obvious one is deadlock: this runs
     * inside `navigator.locks.request`'s callback, and a listener that took any lock from there would
     * be queuing behind a frame that has not returned. The other is that a listener throwing must not
     * reject the request that granted the lock - that would release the lock this tab has just been
     * given, which is the takeover undoing itself.</p>
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
