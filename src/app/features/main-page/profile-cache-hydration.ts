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

/**
 * Which blocking dialog `resolveAccountGates()` handed the screen to, when it did.
 *
 * <p>The two are not interchangeable for this decision. `AccountOnboardingComponent` is a genuine
 * opaque full-screen takeover (`fixed inset-0 ... bg-app-bg`, deliberately not a dialog - see its
 * own class comment) - nothing behind it is visible, so there is nothing to hydrate before
 * revealing it. `EmailVerificationDialogComponent` is a `p-dialog` with the default PrimeNG mask
 * (`rgba(0,0,0,0.4)`, translucent), rendered over `main-page.component.html`, which is not gated on
 * readiness at all - the server rail, sidebar and whatever `NavigationService.mainView()` restored
 * from `localStorage` all render behind it, dimmed but visible. For a returning user that can
 * include `GuildMemberListComponent`, whose raw-`userId` fallback is exactly the bug this whole
 * cache exists to remove.</p>
 */
export type AccountGateBlock = 'onboarding' | 'email-verification';

/**
 * Reveals whatever `resolveAccountGates()` decided to show, hydrating first only when that surface
 * can actually expose an unresolved profile.
 *
 * @param hasAccountSlot whether a real account slot is live. Only consulted on the
 *     email-verification path, and it is not a refinement - it is the difference between hydrating
 *     the signed-in account and hydrating nothing under a name no wipe will ever reach. That path
 *     has two callers and they are not alike: `getSelf()` answering 403 returns before
 *     `establishAccountSlot(user)` has run, so `DeviceIdentityService.deviceId()` answers
 *     `BOOTSTRAP_SLOT_ID` and every read - and every write the session goes on to make - lands in a
 *     namespace `SessionTeardownService.wipeEngineState(deviceId)` is never given the id of. There
 *     is no cached data for an account with no established slot, so hydrating there can only do
 *     harm. The unverified-email branch <i>does</i> have a slot by then, and still hydrates.
 */
export async function revealAfterAccountGateBlock(
    block: AccountGateBlock,
    steps: ProfileCacheHydrationSteps,
    hasAccountSlot: () => Promise<boolean> = async () => true,
): Promise<void> {
    if (block === 'onboarding') {
        // Opaque takeover: nothing behind it renders yet, so there is nothing hydration could fix
        // that the user could see anyway. Marking ready directly matches runDeviceLaunch's own
        // behaviour before this file existed.
        steps.markReady();
        return;
    }
    // Failing to answer is treated as "no slot", for the same reason the answer matters at all: the
    // cost of skipping hydration is a cold start, and the cost of hydrating without a slot is
    // durable residue under the bootstrap id.
    if (!await hasAccountSlot().catch(() => false)) {
        steps.markReady();
        return;
    }
    // Translucent mask over the still-rendered main-page shell - the exact same hazard
    // runDeviceLaunch guards against, so it gets the exact same treatment.
    await hydrateThenReveal(steps);
}
