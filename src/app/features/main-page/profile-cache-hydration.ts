/**
 * Loads cached profiles before the splash comes down, and never lets a cache fault hold it up.
 *
 * <p>Lifted out of `MainPageComponent` as a plain function over its steps, for the same reason
 * {@link runMlsLaunch} and {@link runSignOut} were: the thing worth pinning is control flow -
 * <i>hydrate, then reveal, in that order, unconditionally</i> - and that lived invisibly inside a
 * component nothing can construct without half the application. Folding
 * {@link ProfileCacheHydrationSteps.markReady} into the same function (rather than leaving the
 * caller to sequence `await hydrateThenReveal(...)` followed by its own `markReady()` call) is
 * deliberate: it is what lets a test assert the ordering against the exact code path production
 * runs, instead of against a copy of it.</p>
 *
 * <p><b>Why this matters.</b> The splash is what hides an empty first paint, and an empty profile
 * map is exactly what puts a raw `user_...` id on screen - see `ProfileCacheService`. So hydration
 * has to land before the reveal. But the cache is allowed to not exist yet, or to fail to open -
 * a missing sealing key, an IndexedDB fault, a first run with nothing on disk - and none of that
 * may cost the user the app. Catching here rather than trusting the splash's own safety net
 * (`SPLASH_SAFETY_NET_MS`) is the difference between a silent cold start and an 8 second hang.</p>
 */

export interface ProfileCacheHydrationSteps {
    /** `ProfileCacheService.hydrate()`. Resolves with how many profiles were loaded from disk. */
    hydrate: () => Promise<number>;
    /**
     * `ProfileCacheService.revalidateAll()`. Only worth calling when something was actually
     * hydrated - queuing revalidation for an empty set is pointless work on the boot path.
     */
    revalidateAll: () => void;
    /** `AppReadyService.markReady()`. Takes the splash down. */
    markReady: () => void;
}

export async function hydrateThenReveal(steps: ProfileCacheHydrationSteps): Promise<void> {
    const cached = await steps.hydrate().catch(() => 0);
    if (cached > 0) steps.revalidateAll();
    steps.markReady();
}
