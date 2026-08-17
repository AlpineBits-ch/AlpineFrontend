/** What has to happen, and in what order, before this device can read encrypted contexts. */

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
     * and holds no group for. Must run last, after any waiting Welcome has been taken.
     */
    sweepForAdmission: () => Promise<void>;
}

export interface MlsLaunchOutcome {
    /** The session handle, or null when the unlock did not produce one. */
    handle: string | null;
    /** No signing key is stored at all: the interactive registration modal is the right answer. */
    needsRegistration: boolean;
    /**
     * The key store could not be read for some other reason. Never {@link needsRegistration}:
     * registering mints a fresh keypair and orphans this device from every group it belongs to.
     */
    keyStoreUnreachable: boolean;
    /**
     * Some of this device's signing-key entries are there and some are not. Neither
     * {@link needsRegistration} nor {@link keyStoreUnreachable}: the reads succeeded, so a retry
     * will not lift it, and an entry that exists means registering would overwrite a live key.
     */
    keyStoreIncomplete: boolean;
    /**
     * The stored signing key belongs to a different account than the one signed in. Per-account
     * device ids should make this unreachable, so it means the account scoping resolved wrongly.
     */
    identityMismatch: boolean;
    /** Key packages could not be uploaded. Independent of the other steps; may not take them down. */
    keyPackagesFailed: boolean;
    /** The §B discovery sweep did not complete. For the log; per-context outcomes go to the banner. */
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
            identityMismatch: kind === 'IdentityMismatch',
            keyStoreIncomplete: kind === 'KeyStoreIncomplete',
            // Catch-all, so an unrecognised kind surfaces as a key-store fault rather than as a
            // prompt to register, which is the one response that cannot be taken back.
            keyStoreUnreachable: kind !== 'KeyNotFound'
                && kind !== 'IdentityMismatch'
                && kind !== 'KeyStoreIncomplete',
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

    // Last, and only after the two above have settled: it asks against the group state they leave.
    const swept = await steps.sweepForAdmission().then(() => true, (err: unknown) => {
        console.error('The MLS admission sweep did not complete', err);
        return false;
    });

    return {
        handle,
        needsRegistration: false,
        identityMismatch: false,
        keyStoreIncomplete: false,
        keyStoreUnreachable: false,
        keyPackagesFailed: !replenished,
        admissionSweepFailed: !swept,
    };
}
