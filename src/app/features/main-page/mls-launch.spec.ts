import {MlsLaunchSteps, runMlsLaunch} from './mls-launch';

function steps(overrides: Partial<MlsLaunchSteps> = {}) {
    const calls: string[] = [];
    const base: MlsLaunchSteps = {
        unlock: async () => {
            calls.push('unlock');
            return 'handle';
        },
        replenish: async () => {
            calls.push('replenish');
        },
        checkMasterKey: () => {
            calls.push('checkMasterKey');
        },
        processWelcomes: async () => {
            calls.push('processWelcomes');
        },
        sweepForAdmission: async () => {
            calls.push('sweepForAdmission');
        },
    };
    return {calls, steps: {...base, ...overrides}};
}

/** A rejection shaped like `MlsService.autoUnlock`'s. */
const keyNotFound = {kind: 'KeyNotFound', message: 'no signing key'};

/** A rejection shaped like an `HttpErrorResponse` - no `kind` anywhere on it. */
const httpFailure = Object.assign(new Error('Http failure response: 404 Not Found'), {status: 404});

describe('runMlsLaunch', () => {
    it('runs every step on a healthy launch', async () => {
        const {calls, steps: s} = steps();

        const outcome = await runMlsLaunch(s);

        expect(calls).toEqual([
            'unlock', 'checkMasterKey', 'replenish', 'processWelcomes', 'sweepForAdmission',
        ]);
        expect(outcome).toEqual({
            handle: 'handle',
            needsRegistration: false,
            identityMismatch: false,
            keyStoreIncomplete: false,
            keyStoreUnreachable: false,
            keyPackagesFailed: false,
            admissionSweepFailed: false,
        });
    });

    it('still processes pending Welcomes when the key-package upload fails', async () => {
        const {calls, steps: s} = steps({
            replenish: async () => {
                throw httpFailure;
            },
        });

        const outcome = await runMlsLaunch(s);

        // The step that used to be cancelled. Without it a device invited to a group never joins
        // it, on every launch, and nothing repairs that later.
        expect(calls).toContain('processWelcomes');
        expect(outcome.keyPackagesFailed).toBe(true);
    });

    it('still checks the master key when the key-package upload fails', async () => {
        const {calls, steps: s} = steps({
            replenish: async () => {
                throw httpFailure;
            },
        });

        await runMlsLaunch(s);

        // A half-finished encryption setup is only ever re-offered from here.
        expect(calls).toContain('checkMasterKey');
    });

    it('does not blame the key store for a failed key-package upload', async () => {
        const {steps: s} = steps({
            replenish: async () => {
                throw httpFailure;
            },
        });

        const outcome = await runMlsLaunch(s);

        expect(outcome.keyStoreUnreachable).toBe(false);
        expect(outcome.needsRegistration).toBe(false);
        expect(outcome.handle).toBe('handle');
    });

    it('still replenishes when joining from a Welcome throws', async () => {
        const {calls, steps: s} = steps({
            processWelcomes: async () => {
                throw new Error('join failed');
            },
        });

        const outcome = await runMlsLaunch(s);

        expect(calls).toContain('replenish');
        expect(outcome.keyPackagesFailed).toBe(false);
    });

    it('asks for registration only when no signing key is stored', async () => {
        const {calls, steps: s} = steps({
            unlock: async () => {
                calls.push('unlock');
                throw keyNotFound;
            },
        });

        const outcome = await runMlsLaunch(s);

        expect(outcome.needsRegistration).toBe(true);
        expect(outcome.keyStoreUnreachable).toBe(false);
        // Nothing past the unlock: there is no session to replenish, join or ask with.
        expect(calls).toEqual(['unlock']);
    });

    it('runs the admission sweep only after Welcomes have been taken', async () => {
        const {calls, steps: s} = steps();

        await runMlsLaunch(s);

        // Asking to be admitted to something a waiting Welcome was about to fix is a request
        // nobody needs to review.
        expect(calls.indexOf('sweepForAdmission'))
            .toBeGreaterThan(calls.indexOf('processWelcomes'));
    });

    it('reports a failed admission sweep without disturbing the steps before it', async () => {
        const {calls, steps: s} = steps({
            sweepForAdmission: async () => {
                throw new Error('conversation list unavailable');
            },
        });

        const outcome = await runMlsLaunch(s);

        expect(outcome.admissionSweepFailed).toBe(true);
        expect(outcome.keyPackagesFailed).toBe(false);
        expect(outcome.keyStoreUnreachable).toBe(false);
        expect(outcome.handle).toBe('handle');
        expect(calls).toContain('checkMasterKey');
        expect(calls).toContain('replenish');
        expect(calls).toContain('processWelcomes');
    });

    it('still sweeps when the key-package upload and the Welcomes both fail', async () => {
        const {calls, steps: s} = steps({
            replenish: async () => {
                throw httpFailure;
            },
            processWelcomes: async () => {
                throw new Error('join failed');
            },
        });

        const outcome = await runMlsLaunch(s);

        // The stranded-device case: nothing else worked, so discovery is the only thing left that
        // can get this device back in.
        expect(calls).toContain('sweepForAdmission');
        expect(outcome.admissionSweepFailed).toBe(false);
    });

    it('never asks for registration on an unreachable key store', async () => {
        const {steps: s} = steps({
            unlock: async () => {
                throw {kind: 'MlsError', message: 'Secure storage is unavailable'};
            },
        });

        const outcome = await runMlsLaunch(s);

        // Registering mints a fresh keypair over live group state, which cannot be undone.
        expect(outcome.needsRegistration).toBe(false);
        expect(outcome.keyStoreUnreachable).toBe(true);
        expect(outcome.identityMismatch).toBe(false);
    });

    it('never asks for registration when the stored key belongs to another account', async () => {
        const {calls, steps: s} = steps({
            unlock: async () => {
                calls.push('unlock');
                throw {kind: 'IdentityMismatch', message: 'stored key belongs to user-a'};
            },
        });

        const outcome = await runMlsLaunch(s);

        // The key that is there is the right key for *somebody*, and registering would replace it
        // with a fresh one - orphaning whichever account it does belong to from every group it is
        // in. The situation is a scoping bug and is entirely recoverable; that response is not.
        expect(outcome.identityMismatch).toBe(true);
        expect(outcome.needsRegistration).toBe(false);
        // Not folded into the generic key-store failure either: they have different causes and the
        // log has to be able to say which happened.
        expect(outcome.keyStoreUnreachable).toBe(false);
        expect(outcome.handle).toBeNull();
        expect(calls).toEqual(['unlock']);
    });

    /**
     * A key store holding part of this device's key. The entry that is present is the one
     * registration would replace, so this must never be `needsRegistration` - and it is not
     * `keyStoreUnreachable` either, because that state's answer is a retry and this one does not lift:
     * the reads succeeded and reported what is there.
     */
    it('never asks for registration when only part of the signing key is stored', async () => {
        const {calls, steps: s} = steps({
            unlock: async () => {
                calls.push('unlock');
                throw {kind: 'KeyStoreIncomplete', message: 'pub: present, priv: present, identity: absent'};
            },
        });

        const outcome = await runMlsLaunch(s);

        expect(outcome.keyStoreIncomplete).toBe(true);
        expect(outcome.needsRegistration).toBe(false);
        expect(outcome.keyStoreUnreachable).toBe(false);
        expect(outcome.identityMismatch).toBe(false);
        expect(outcome.handle).toBeNull();
        expect(calls).toEqual(['unlock']);
    });

    /**
     * The catch-all direction. A kind nobody has thought of yet - a future refusal, a rejection that
     * lost its `kind` in transit - has to land on the key-store state rather than on the prompt that
     * mints a fresh keypair. This is the property that makes adding a kind safe.
     */
    it('sends an unrecognised kind to the key store state, never to registration', async () => {
        const {steps: s} = steps({
            unlock: async () => {
                throw {kind: 'SomeKindNobodyHasWrittenYet', message: 'from the future'};
            },
        });

        const outcome = await runMlsLaunch(s);

        expect(outcome.needsRegistration).toBe(false);
        expect(outcome.keyStoreIncomplete).toBe(false);
        expect(outcome.keyStoreUnreachable).toBe(true);
    });

    it('reports no mismatch on a clean launch', async () => {
        const {steps: s} = steps();

        await expect(runMlsLaunch(s)).resolves.toMatchObject({identityMismatch: false});
    });
});
