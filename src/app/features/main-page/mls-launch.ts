/**
 * What has to happen, and in what order, before this device can read encrypted contexts.
 *
 * <p>Lifted out of `MainPageComponent` as a plain function over its steps, because the bug it
 * exists to prevent is entirely about control flow and was invisible while it lived inside a
 * component nothing could construct without half the application.</p>
 */

/** The steps, injected so the ordering can be exercised without an Angular anything. */
export interface MlsLaunchSteps {
    /** Loads this device's signing key from the OS key store. Rejects with `{kind}` on failure. */
    unlock: () => Promise<string>;
    /** Tops up the server's stock of key packages for this device. */
    replenish: () => Promise<void>;
    /** Asks whether the account's master key exists and is openable, and prompts if not. */
    checkMasterKey: () => void;
    /** Joins every group this device has been invited to while it was away. */
    processWelcomes: () => Promise<void>;
    /**
     * Contract §B discovery: asks to be admitted to everything this device should be able to read
     * and holds no group for.
     *
     * <p>Deliberately last. It is the only step whose work is proportional to the number of
     * conversations, and it is the least urgent - a Welcome already waiting has to be taken before
     * this device starts asking to be re-added to anything.</p>
     */
    sweepForAdmission: () => Promise<void>;
}

export interface MlsLaunchOutcome {
    /** The session handle, or null when the unlock did not produce one. */
    handle: string | null;
    /** No signing key is stored at all: the interactive registration modal is the right answer. */
    needsRegistration: boolean;
    /**
     * The key store could not be read for some other reason.
     *
     * <p>Deliberately not the same state as {@link needsRegistration}: registering mints a *fresh*
     * signing keypair, which orphans this device from every group it belongs to and cannot be
     * undone. A locked keychain, a credential service that has not started yet or a transient DBus
     * failure is not evidence that this device was never registered.</p>
     */
    keyStoreUnreachable: boolean;
    /**
     * Key packages could not be uploaded.
     *
     * <p>Reported on its own, and it is the reason this function exists. All four steps used to sit
     * in one `try` with the replenish first and awaited, so a single `HttpErrorResponse` from it -
     * which carries no `kind` - landed in the key-store branch and cancelled the two steps after
     * it. The master-key check never ran, so a half-finished encryption setup was never re-offered
     * and never repaired itself; Welcomes were never processed, so the device never joined a single
     * group it had been invited to and stayed silently unreadable while the account's other devices
     * were fine; and the user was told the key store was unreachable when the keychain had worked.
     * None of the three depends on another, so none may take another down.</p>
     */
    keyPackagesFailed: boolean;
    /**
     * The §B discovery sweep did not complete.
     *
     * <p>Isolated and reported rather than thrown, for the same reason as everything else here: the
     * sweep runs after the steps that decide whether this device can read anything at all, and a
     * failure to *discover* an exclusion must not undo the ones that were already fixed. Its own
     * per-context outcomes are surfaced through the banner by `MlsJoinRequestService`, so this flag
     * is for the log.</p>
     */
    admissionSweepFailed: boolean;
}

export async function runMlsLaunch(steps: MlsLaunchSteps): Promise<MlsLaunchOutcome> {
    let handle: string;
    try {
        handle = await steps.unlock();
    } catch (err: unknown) {
        const kind = (err as {kind?: string} | null)?.kind;
        return {
            handle: null,
            needsRegistration: kind === 'KeyNotFound',
            keyStoreUnreachable: kind !== 'KeyNotFound',
            keyPackagesFailed: false,
            admissionSweepFailed: false,
        };
    }

    // Independent of each other from here on. `checkMasterKey` is synchronous and fires its own
    // request; the other two are awaited together so one rejecting cannot skip the other.
    steps.checkMasterKey();

    const [replenished] = await Promise.all([
        steps.replenish().then(() => true, () => false),
        // An unreadable conversation is bad; a client that will not start is worse.
        steps.processWelcomes().catch(err =>
            console.error('Failed to process pending Welcomes at launch', err)),
    ]);

    // Last, alone, and after the two above have settled - it decides what to ask for from the group
    // state they leave behind, and asking to be admitted to something a Welcome was about to fix is
    // a request nobody needs to review.
    const swept = await steps.sweepForAdmission().then(() => true, (err: unknown) => {
        console.error('The MLS admission sweep did not complete', err);
        return false;
    });

    return {
        handle,
        needsRegistration: false,
        keyStoreUnreachable: false,
        keyPackagesFailed: !replenished,
        admissionSweepFailed: !swept,
    };
}
