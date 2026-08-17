import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {FakeLockManager} from '../testing/fake-lock-manager';
import {
    detectLockManager,
    SessionClaim,
    SessionLock,
    sessionLockName,
    WebLocksSessionLock,
} from './session-lock';

/**
 * The primitive the single-session guard is built on.
 *
 * <p>Tested separately from the MLS adapter because the two failure modes are different: the adapter
 * has to <i>refuse</i> when it does not own a scope, and this file has to establish that "own" means
 * what it says - exactly one holder per name per profile, a grant that arrives by itself when the holder
 * goes away, and no waiting on the boot path.</p>
 *
 * <p>{@link FakeLockManager} stands for one browser profile. One instance shared between two locks is
 * two tabs; that sharing is the whole test, and a per-lock instance would make every assertion here
 * pass for the wrong reason.</p>
 */

const NAME = sessionLockName('device-a');

let profile: FakeLockManager;

beforeEach(() => {
    profile = new FakeLockManager();
});

const lockIn = (manager: FakeLockManager = profile, name = NAME): SessionLock =>
    new WebLocksSessionLock(name, manager);

/**
 * Lets a release and the grant behind it run.
 *
 * <p>Neither is synchronous - a browser hands a released lock to the next waiter in a later task, and
 * the fake models that in microtasks - so a test that asserted straight after a release would be
 * asserting the moment before the handover rather than after it.</p>
 */
async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('sessionLockName', () => {
    it('names the scope, so two accounts in one profile do not lock each other out', () => {
        expect(sessionLockName('device-a')).not.toBe(sessionLockName('device-b'));
    });

    it('gives an absent scope a name of its own rather than sharing an account name', () => {
        expect(sessionLockName(undefined)).not.toBe(sessionLockName('device-a'));
        expect(sessionLockName(undefined)).toContain('unscoped');
    });
});

describe('WebLocksSessionLock', () => {
    it('is held by the first claim and reports so', async () => {
        const first = lockIn();

        await expect(first.claim()).resolves.toBe('held');
        expect(first.held).toBe(true);
        expect(first.state).toBe('held');
    });

    it('keeps holding the lock after the claim resolves', async () => {
        // The reason `request` is inverted: a lock that were released when `claim()` resolved would let
        // the second tab straight in, and every guard above it would be decoration.
        const first = lockIn();
        await first.claim();

        expect(profile.isHeld(NAME)).toBe(true);
    });

    it('refuses a second claim in the same profile', async () => {
        await lockIn().claim();

        await expect(lockIn().claim()).resolves.toBe('blocked');
    });

    it('does not make the second claim wait for the first tab', async () => {
        await lockIn().claim();
        const second = lockIn();

        // Resolving at all is the assertion: an `await` that only completed when the other tab closed
        // would hang the boot path for as long as that tab stays open.
        await expect(second.claim()).resolves.toBe('blocked');
        expect(second.held).toBe(false);
    });

    it('leaves a request queued, so the takeover needs no polling', async () => {
        await lockIn().claim();
        await lockIn().claim();

        expect(profile.waitingOn(NAME)).toBe(1);
    });

    it('queues one request however many times the blocked tab asks', async () => {
        await lockIn().claim();
        const second = lockIn();
        await second.claim();
        await second.claim();
        await second.claim();

        // Asking again must not queue again: the takeover arrives through the first request, and a
        // second one would sit behind it and never be granted.
        expect(profile.waitingOn(NAME)).toBe(1);
    });

    it('is granted to the waiting tab when the holding tab is closed', async () => {
        const first = lockIn();
        const second = lockIn();
        await first.claim();
        await second.claim();

        // Not a release: the tab is gone. This is the case a heartbeat cannot report, and the reason
        // this is built on Web Locks.
        profile.closeTab(NAME);
        await settle();

        expect(second.held).toBe(true);
        await expect(second.claim()).resolves.toBe('held');
    });

    it('hands a released lock to the next tab in order', async () => {
        const first = lockIn();
        const second = lockIn();
        await first.claim();
        await second.claim();

        first.release();
        await settle();

        expect(first.held).toBe(false);
        expect(second.held).toBe(true);
    });

    it('does not report itself blocked by its own concurrent claims', async () => {
        // Two commands arriving at once used to issue two `ifAvailable` probes: the first took the lock
        // and the second found it taken - by this same tab - and reported `blocked`. The claim is shared
        // for exactly that reason.
        const only = lockIn();

        const [a, b, c] = await Promise.all([only.claim(), only.claim(), only.claim()]);

        expect([a, b, c]).toEqual(['held', 'held', 'held']);
        expect(profile.requested).toEqual([NAME]);
    });

    it('does not contend with a different scope', async () => {
        await lockIn(profile, sessionLockName('device-a')).claim();

        await expect(lockIn(profile, sessionLockName('device-b')).claim()).resolves.toBe('held');
    });

    it('does not contend across profiles, because a lock manager is per profile', async () => {
        await lockIn(profile).claim();

        await expect(lockIn(new FakeLockManager()).claim()).resolves.toBe('held');
    });

    it('reports unsupported where there is no lock manager, and claims nothing', async () => {
        const lock = new WebLocksSessionLock(NAME, undefined);

        await expect(lock.claim()).resolves.toBe('unsupported');
        expect(lock.held).toBe(false);
        expect(lock.state).toBe('unsupported');
    });

    it('reports unsupported rather than rejecting when the lock manager will not answer', async () => {
        // A partial implementation, or a context that refuses the request. This must not reject: the
        // first claim happens inside `mls_init_storage`, and an `initStorage` rejection is what the boot
        // path answers by wiping local MLS state - so a broken lock manager would cost group keys.
        const refusing = {
            request: () => Promise.reject(new Error('NotSupportedError')),
            query: () => Promise.reject(new Error('NotSupportedError')),
        } as LockManager;

        await expect(new WebLocksSessionLock(NAME, refusing).claim()).resolves.toBe('unsupported');
    });

    it('reports unclaimed before anything has been attempted', () => {
        expect(lockIn().state).toBe('unclaimed');
    });

    it('drops its queued request when it gives up the scope', async () => {
        const holder = lockIn();
        const leaving = lockIn();
        await holder.claim();
        await leaving.claim();
        expect(leaving.queueing).toBe(true);

        leaving.release();
        await settle();

        // A lease abandoned while queued - which is what an account switch inside one document does -
        // would otherwise still be granted the lock when the holder went away, and its callback holds
        // forever. The tab would own a scope nothing in it uses and lock every other tab out of that
        // account until it closed.
        expect(profile.waitingOn(NAME)).toBe(0);
        holder.release();
        await settle();
        expect(leaving.held).toBe(false);
        expect(profile.isHeld(NAME)).toBe(false);
    });

    it('never leaves the lock free between one holder and the next', async () => {
        // The gap this rules out is one turn wide: the queue has promised the lock to the waiter, whose
        // callback has not run yet, and a third tab let in there would hold the scope alongside it -
        // the state this guard exists to make impossible. A single probe lands wherever it happens to
        // land and proves nothing, so the probe is walked across every microtask depth of the handover,
        // one fresh scope per depth.
        const answers: SessionClaim[] = [];
        for (let depth = 0; depth < 12; depth++) {
            const name = sessionLockName(`handover-${depth}`);
            const holder = lockIn(profile, name);
            const waiting = lockIn(profile, name);
            await holder.claim();
            await waiting.claim();

            holder.release();
            for (let tick = 0; tick < depth; tick++) await Promise.resolve();
            answers.push(await lockIn(profile, name).claim());

            await settle();
            expect(waiting.held, `depth ${depth}`).toBe(true);
        }

        expect(answers).toEqual(Array<SessionClaim>(12).fill('blocked'));
    });

    it('lets a released lock be claimed again by the same tab', async () => {
        const only = lockIn();
        await only.claim();
        only.release();
        await settle();

        await expect(only.claim()).resolves.toBe('held');
    });
});

describe('detectLockManager', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('reports the absence rather than throwing where there is no navigator.locks', () => {
        // The test environment has none, which is also the shape of an insecure origin and of Safari
        // before 15.4 - the two contexts the fallback decision is about.
        expect(detectLockManager()).toBeUndefined();
    });

    it('reports the absence rather than throwing where reading navigator throws', () => {
        vi.stubGlobal(
            'navigator',
            new Proxy(
                {},
                {
                    get: () => {
                        throw new Error('blocked by the embedder');
                    },
                },
            ),
        );

        expect(detectLockManager()).toBeUndefined();
    });

    it('rejects a navigator.locks that is not a lock manager', () => {
        // A partial polyfill must report unsupported here rather than fail later inside a request,
        // where the failure would arrive as an unexplained rejection on the boot path.
        vi.stubGlobal('navigator', {locks: {}});

        expect(detectLockManager()).toBeUndefined();
    });

    it('accepts a lock manager', () => {
        vi.stubGlobal('navigator', {locks: new FakeLockManager()});

        expect(detectLockManager()).toBeDefined();
    });
});
