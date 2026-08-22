/**
 * Loads the sealed caches before the splash comes down, and never lets a cache fault hold it up.
 * Hydrate, then reveal, in that order, unconditionally: an empty profile map is what puts a raw
 * `user_...` id on screen, an empty conversation store is what leaves the DM list blank for a round
 * trip after the splash, and a cache fault must not cost the user the app.
 */

export interface LaunchHydrationSteps {
    /** `ProfileCacheService.hydrate()`. Resolves with how many profiles were loaded from disk. */
    hydrate: () => Promise<number>;
    /** `ConversationStore.hydrate()`. Resolves with how many conversations were loaded from disk. */
    hydrateConversations: () => Promise<number>;
    /** `ProfileCacheService.revalidateAll()`. Only worth calling when something was hydrated. */
    revalidateAll: () => void;
    /** `AppReadyService.markReady()`. Takes the splash down. */
    markReady: () => void;
}

export async function hydrateThenReveal(steps: LaunchHydrationSteps): Promise<void> {
    // In parallel, and each swallowing its own fault: neither cache is the other's precondition,
    // and the splash is held for as long as the slower one takes either way.
    const [cached] = await Promise.all([
        steps.hydrate().catch(() => 0),
        steps.hydrateConversations().catch(() => 0),
    ]);
    if (cached > 0) steps.revalidateAll();
    steps.markReady();
}

/**
 * Which blocking surface `resolveAccountGates()` handed the screen to, when it did. Not
 * interchangeable: the first-run takeover is opaque, so nothing behind it needs hydrating, while
 * the email-verification dialog is a translucent mask over the still-rendered main-page shell.
 */
export type AccountGateBlock = 'first-run' | 'email-verification';

/**
 * Reveals whatever `resolveAccountGates()` decided to show, hydrating first only when that surface
 * can actually expose an unresolved profile.
 *
 * @param hasAccountSlot whether a real account slot is live. Only consulted on the
 *     email-verification path, where a 403 from `getSelf()` returns before `establishAccountSlot`
 *     has run: hydrating there reads and writes under `BOOTSTRAP_SLOT_ID`, which no wipe is ever
 *     handed the id of.
 */
export async function revealAfterAccountGateBlock(
    block: AccountGateBlock,
    steps: LaunchHydrationSteps,
    hasAccountSlot: () => Promise<boolean> = async () => true,
): Promise<void> {
    if (block === 'first-run') {
        // Opaque takeover: nothing behind it renders, so hydration could fix nothing visible.
        steps.markReady();
        return;
    }
    // Failing to answer is treated as "no slot": skipping hydration costs a cold start, hydrating
    // without a slot leaves durable residue under the bootstrap id.
    if (!(await hasAccountSlot().catch(() => false))) {
        steps.markReady();
        return;
    }
    // Translucent mask over the still-rendered shell, the same hazard runDeviceLaunch guards against.
    await hydrateThenReveal(steps);
}
