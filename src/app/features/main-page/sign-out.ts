/**
 * What has to happen, and in what order, when a session ends. Dropping the OAuth token is not
 * enough: the seal key is derived per device rather than per account, so any key material, groups
 * or history left on disk is readable by whoever signs in next.
 */

/** The steps, injected so the ordering can be exercised without an Angular anything. */
export interface SignOutSteps {
    /** This account's device id. Everything local is named after it. */
    deviceId: () => Promise<string>;
    /**
     * Stops detecting games and tells the server this account is no longer playing anything. Must
     * run before {@link dropTokens}: it ends in an authenticated write that a dropped token 401s.
     */
    clearActivity: () => void;
    /** Destroys this device's key material for the account. */
    wipeAccount: (deviceId: string) => Promise<unknown>;
    /**
     * Forgets this account's cached guild layout. Belongs here rather than in
     * {@link SessionTeardownService.wipeAccount}, which is addressed by device id while this cache
     * is keyed by account slot.
     */
    clearGuildCache: () => void;
    /**
     * Empties the conversation store, whose write-behind would otherwise seal the outgoing
     * account's DM list straight back onto disk after {@link wipeAccount} cleared it.
     */
    clearConversations: () => void;
    /** Discards the OAuth tokens. */
    dropTokens: () => void;
    /** Leaves for the login screen. */
    goToLogin: () => void;
}

export interface SignOutOutcome {
    /** Whether the local wipe completed. False means key material may still be on disk. */
    wiped: boolean;
}

export async function runSignOut(steps: SignOutSteps): Promise<SignOutOutcome> {
    // First, and outside the try: it is a fire-and-forget local call that cannot reject, and it
    // must not be skipped because the wipe below threw.
    steps.clearActivity();

    let wiped = false;
    try {
        // Must precede dropping the tokens: the wipe ends in an authenticated call resetting this
        // device's server-side key packages (contract §A), and a dropped token turns it into a 401.
        wiped = await steps.wipeAccount(await steps.deviceId()).then(() => true);
    } catch (err) {
        console.error('Could not fully wipe local MLS state on sign-out', err);
    }

    // All four run whatever happened above: a failed local wipe must not trap the user in the
    // session they asked to leave.
    steps.clearGuildCache();
    steps.clearConversations();
    steps.dropTokens();
    steps.goToLogin();
    return {wiped};
}
