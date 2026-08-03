/**
 * The sign-out ordering, and the wipe that was not happening at all.
 *
 * <p>The first test here fails against the code this replaces: `goToLogin` dropped the OAuth token
 * and navigated, and never touched a single local store. Everything the account held on this
 * machine - signing key, groups, registry, plaintext message history - stayed on disk and was
 * loaded by whoever signed in next.</p>
 */
import {runSignOut, SignOutSteps} from './sign-out';

function steps(overrides: Partial<SignOutSteps> = {}) {
    const calls: string[] = [];
    const base: SignOutSteps = {
        deviceId: async () => {
            calls.push('deviceId');
            return 'device-a';
        },
        wipeAccount: async id => { calls.push(`wipeAccount:${id}`); },
        dropTokens: () => { calls.push('dropTokens'); },
        goToLogin: () => { calls.push('goToLogin'); },
    };
    return {calls, steps: {...base, ...overrides}};
}

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => { }));
afterEach(() => vi.restoreAllMocks());

it('wipes this device key material before leaving', async () => {
    const {calls, steps: s} = steps();

    const outcome = await runSignOut(s);

    expect(calls).toEqual(['deviceId', 'wipeAccount:device-a', 'dropTokens', 'goToLogin']);
    expect(outcome.wiped).toBe(true);
});

it('wipes before dropping the tokens the wipe needs', async () => {
    const {calls, steps: s} = steps();

    await runSignOut(s);

    // The wipe ends with an authenticated call to reset this device's server-side key packages
    // (contract §A). Dropping the token first turns it into a 401, the server keeps handing out
    // packages whose private halves were just deleted, and every Welcome sealed to one of them is
    // undecryptable by the device it was addressed to.
    expect(calls.indexOf('wipeAccount:device-a')).toBeLessThan(calls.indexOf('dropTokens'));
});

it('still signs out when the wipe fails, and says it did not happen', async () => {
    const {calls, steps: s} = steps({
        wipeAccount: async () => { throw new Error('keychain locked'); },
    });

    const outcome = await runSignOut(s);

    // This is also the escape hatch people reach for when something is already wrong.
    expect(calls).toContain('dropTokens');
    expect(calls).toContain('goToLogin');
    expect(outcome.wiped).toBe(false);
});

it('still signs out when the device id cannot be resolved', async () => {
    const {calls, steps: s} = steps({
        deviceId: async () => { throw new Error('store unavailable'); },
    });

    const outcome = await runSignOut(s);

    expect(calls.some(c => c.startsWith('wipeAccount'))).toBe(false);
    expect(calls).toContain('goToLogin');
    expect(outcome.wiped).toBe(false);
});

it('navigates after the tokens are gone, never before', async () => {
    const {calls, steps: s} = steps();

    await runSignOut(s);

    // Navigating first leaves the login screen rendering against a session that is briefly still
    // valid, which is how a redirect back into the app on launch used to happen.
    expect(calls.indexOf('dropTokens')).toBeLessThan(calls.indexOf('goToLogin'));
});

it('wipes the account the device id names, not some other one', async () => {
    const {calls, steps: s} = steps({deviceId: async () => 'device-for-account-b'});

    await runSignOut(s);

    expect(calls).toContain('wipeAccount:device-for-account-b');
});
