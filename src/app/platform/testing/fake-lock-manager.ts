/**
 * A {@link LockManager} for specs, because jsdom has none.
 *
 * <p>One instance stands for <b>one browser profile</b>: hand the same instance to two adapters and
 * they contend exactly as two tabs do, which is the only way the single-session guard can be tested at
 * all. A per-adapter instance would let both "tabs" hold the lock and every guard test would pass
 * vacuously.</p>
 *
 * <p>It models the parts of the API the guard depends on and nothing else:</p>
 * <ul>
 *   <li><b>Exclusive means exclusive.</b> One holder per name; everything else queues.</li>
 *   <li><b>`ifAvailable` never waits.</b> The callback is invoked with `null` when the name is taken,
 *       which is the API's only way of saying no.</li>
 *   <li><b>The lock is held until the callback's promise settles</b>, and the next waiter is granted in
 *       request order. That is what makes a takeover automatic, so the ordering is load bearing.</li>
 *   <li><b>Callbacks run asynchronously</b>, as they do in a browser. Running them synchronously would
 *       hide the ordering bug where a caller reads `held` before the grant has happened.</li>
 *   <li><b>Ownership passes to the next waiter synchronously</b>, at the moment the holder lets go, even
 *       though its callback runs a microtask later. An earlier version of this fake left the name
 *       momentarily free in between, and an `ifAvailable` probe landing in that window was granted a
 *       lock the queue had already promised to someone else - two "holders" at once, which is precisely
 *       the state the guard under test must never see.</li>
 *   <li><b>`signal` drops a queued request</b>, rejecting it, which is how a tab that gives up on a
 *       scope stops being granted the lock later.</li>
 * </ul>
 *
 * <p>Not modelled: shared mode (this app takes only exclusive locks, and a silent downgrade would be
 * worse than a throw), `steal` and `query`. Each rejects rather than pretending.</p>
 *
 * <p>Lives beside the port fakes rather than inside one spec because two specs need it - the lock's own
 * and the MLS adapter's - and a helper imported out of a `.spec.ts` is not compiled by the app
 * project.</p>
 */

interface Waiter {
    readonly options: LockOptions;
    readonly callback: (lock: Lock | null) => unknown;
    readonly settle: (value: unknown) => void;
    readonly fail: (reason: unknown) => void;
}

interface Entry {
    /** Resolving this releases the current holder. Undefined while the name is free. */
    release: (() => void) | undefined;
    readonly waiting: Waiter[];
}

export class FakeLockManager implements LockManager {
    private readonly names = new Map<string, Entry>();

    /** Every name that has ever been requested, for assertions about *which* lock was taken. */
    readonly requested: string[] = [];

    request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
    request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
    request<T>(
        name: string,
        optionsOrCallback: LockOptions | LockGrantedCallback<T>,
        maybeCallback?: LockGrantedCallback<T>,
    ): Promise<T> {
        const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        if (callback === undefined) {
            return Promise.reject(new TypeError('FakeLockManager.request: no callback'));
        }
        if (options.mode !== undefined && options.mode !== 'exclusive') {
            return Promise.reject(new TypeError(
                `FakeLockManager: only exclusive locks are modelled, got "${options.mode}"`,
            ));
        }
        if (options.steal === true) {
            return Promise.reject(new TypeError(
                'FakeLockManager: `steal` is deliberately not modelled - see WebMlsEngine on why the '
                + 'guard does not steal locks',
            ));
        }
        if (options.signal?.aborted === true) {
            return Promise.reject(abortError());
        }

        this.requested.push(name);
        const entry = this.entry(name);

        return new Promise<T>((settle, fail) => {
            const waiter: Waiter = {
                options,
                callback: callback as (lock: Lock | null) => unknown,
                settle: settle as (value: unknown) => void,
                fail,
            };
            if (entry.release !== undefined) {
                // Taken. `ifAvailable` gets its "no" now; anything else waits its turn.
                if (options.ifAvailable === true) {
                    void this.deny(waiter);
                    return;
                }
                entry.waiting.push(waiter);
                options.signal?.addEventListener('abort', () => {
                    const at = entry.waiting.indexOf(waiter);
                    if (at < 0) return;
                    entry.waiting.splice(at, 1);
                    waiter.fail(abortError());
                });
                return;
            }
            this.grant(name, entry, waiter);
        });
    }

    query(): Promise<LockManagerSnapshot> {
        return Promise.reject(new TypeError('FakeLockManager: query() is deliberately not modelled'));
    }

    /** Whether some request currently holds `name`. For asserting the lock outlives a claim. */
    isHeld(name: string): boolean {
        return this.names.get(name)?.release !== undefined;
    }

    /** How many requests are queued behind the holder. A takeover is a queue of one. */
    waitingOn(name: string): number {
        return this.names.get(name)?.waiting.length ?? 0;
    }

    /**
     * Releases whoever holds `name` without their cooperation - a tab closing, crashing, or being
     * discarded by the browser.
     *
     * <p>The case a `localStorage` heartbeat cannot handle, so it is the case the guard has to be tested
     * against.</p>
     */
    closeTab(name: string): void {
        const release = this.names.get(name)?.release;
        release?.();
    }

    private entry(name: string): Entry {
        let entry = this.names.get(name);
        if (entry === undefined) {
            entry = {release: undefined, waiting: []};
            this.names.set(name, entry);
        }
        return entry;
    }

    private async deny(waiter: Waiter): Promise<void> {
        // Asynchronous for the same reason a grant is: `ifAvailable` answers in a later microtask.
        await Promise.resolve();
        try {
            waiter.settle(await waiter.callback(null));
        } catch (err) {
            waiter.fail(err);
        }
    }

    /**
     * Gives `waiter` the lock.
     *
     * <p>Synchronous, deliberately: the name is taken from the instant the queue promises it, and only
     * the <i>callback</i> waits for a microtask. The alternative leaves a gap in which the lock reads as
     * free to an `ifAvailable` probe that the queue has already passed over.</p>
     */
    private grant(name: string, entry: Entry, waiter: Waiter): void {
        let releaseHeld!: () => void;
        const held = new Promise<void>(resolve => {
            releaseHeld = resolve;
        });
        entry.release = releaseHeld;
        void this.run(name, entry, waiter, held, releaseHeld);
    }

    private async run(
        name: string,
        entry: Entry,
        waiter: Waiter,
        held: Promise<void>,
        releaseHeld: () => void,
    ): Promise<void> {
        // Asynchronous, as the API is: a callback invoked synchronously inside `request` would make
        // orderings pass here that cannot happen in a browser.
        await Promise.resolve();

        const lock: Lock = {name, mode: 'exclusive'};
        try {
            waiter.settle(await Promise.race([
                Promise.resolve(waiter.callback(lock)),
                // `held` resolving means the lock was taken back rather than given up, which for a
                // callback that never resolves - the session lock - is how a closed tab arrives.
                held.then(() => undefined),
            ]));
        } catch (err) {
            waiter.fail(err);
        } finally {
            releaseHeld();
            const next = entry.waiting.shift();
            // Ownership moves on in the same turn as it is given up, or not at all.
            if (next === undefined) entry.release = undefined;
            else this.grant(name, entry, next);
        }
    }
}

/** What a dropped request rejects with. `DOMException` where there is one; `Error` in Node. */
function abortError(): Error {
    const Exception = (globalThis as {DOMException?: new (m: string, n: string) => Error}).DOMException;
    if (Exception !== undefined) return new Exception('The lock request was aborted', 'AbortError');
    const error = new Error('The lock request was aborted');
    error.name = 'AbortError';
    return error;
}
