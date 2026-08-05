/**
 * What has to happen, and in what order, when a session ends.
 *
 * <p>Lifted out of `MainPageComponent` as a plain function over its steps, for the same reason
 * {@link runMlsLaunch} was: the bug it exists to prevent is entirely about control flow, and it
 * lived invisibly inside a component nothing can construct without half the application.</p>
 *
 * <p><b>The bug.</b> This path - and the `Ctrl+Shift+L` handler that shares it - dropped the OAuth
 * token and did nothing else. The previous account's signing key, groups, group registry and
 * plaintext message history all stayed on disk, and signing in as somebody else loaded every one
 * of them: the cache seal key is derived per device rather than per account, so none of it even
 * failed to open. The logout dialog did wipe; this did not; and nothing made them agree.</p>
 */

/** The steps, injected so the ordering can be exercised without an Angular anything. */
export interface SignOutSteps {
    /** This account's device id. Everything local is named after it. */
    deviceId: () => Promise<string>;
    /**
     * Stops detecting games and tells the server this account is no longer playing anything.
     *
     * <p>Runs before {@link dropTokens} for the same reason {@link wipeAccount} does: it ends in an
     * authenticated write, and a dropped token turns it into a 401. Presence has a 300 s Redis TTL
     * behind it, so failing here is not permanent - it is five minutes of showing a game to
     * everyone in every shared server after signing out, which is long enough to be the bug people
     * report.</p>
     */
    clearActivity: () => void;
    /** Destroys this device's key material for the account. */
    wipeAccount: (deviceId: string) => Promise<unknown>;
    /** Discards the OAuth tokens. */
    dropTokens: () => void;
    /** Leaves for the login screen. */
    goToLogin: () => void;
}

export interface SignOutOutcome {
    /**
     * Whether the local wipe completed.
     *
     * <p>False means key material may still be on disk. Reported rather than thrown: this is also
     * the escape hatch people reach for when something is already wrong, and a failed teardown
     * must not be the thing that traps them in a session they asked to leave.</p>
     */
    wiped: boolean;
}

export async function runSignOut(steps: SignOutSteps): Promise<SignOutOutcome> {
    // First, and outside the try: it is a fire-and-forget local call that cannot reject, and it
    // must not be skipped because the wipe below threw.
    steps.clearActivity();

    let wiped = false;
    try {
        // Before the tokens go, and that ordering is load-bearing rather than incidental: the wipe
        // ends with an authenticated call to reset this device's server-side key packages
        // (contract §A), and dropping the token first turns it into a 401. The server would then
        // keep handing out packages whose private halves had just been deleted, and every Welcome
        // sealed to one of them is undecryptable by the device it was addressed to.
        wiped = await steps.wipeAccount(await steps.deviceId()).then(() => true);
    } catch (err) {
        console.error('Could not fully wipe local MLS state on sign-out', err);
    }

    // Both run whatever happened above. Leaving someone signed in because a local store would not
    // clear is a worse answer than leaving residue behind and saying so.
    steps.dropTokens();
    steps.goToLogin();
    return {wiped};
}
