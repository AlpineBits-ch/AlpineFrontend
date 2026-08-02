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

        expect(calls).toEqual(['unlock', 'checkMasterKey', 'replenish', 'processWelcomes']);
        expect(outcome).toEqual({
            handle: 'handle',
            needsRegistration: false,
            keyStoreUnreachable: false,
            keyPackagesFailed: false,
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
        // Nothing past the unlock: there is no session to replenish or join with.
        expect(calls).toEqual(['unlock']);
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
    });
});
