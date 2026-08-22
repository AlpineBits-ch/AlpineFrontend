import {FirstRunConditions, owedSteps} from './first-run-steps';
import {UserInterest} from '../dtos/response/UserDto';

function conditions(overrides: Partial<FirstRunConditions> = {}): FirstRunConditions {
    return {
        onboarded: true,
        interests: [UserInterest.Social],
        hasMasterKey: false,
        passwordHeld: false,
        ...overrides,
    };
}

describe('owedSteps', () => {
    it('asks a fresh sign-up to pick, then to save a code', () => {
        const steps = owedSteps(conditions({onboarded: false, interests: undefined, passwordHeld: true}));
        expect(steps).toEqual(['pick', 'recovery-code']);
    });

    it('skips the password step when one was carried in from sign-up', () => {
        const steps = owedSteps(conditions({passwordHeld: true}));
        expect(steps).toEqual(['recovery-code']);
    });

    // QR, an MFA leg, a second device and a failed silent setup all arrive here.
    it('asks for the password when none was carried in', () => {
        const steps = owedSteps(conditions({passwordHeld: false}));
        expect(steps).toEqual(['password', 'recovery-code']);
    });

    it('owes nothing to an account that already holds a key', () => {
        expect(owedSteps(conditions({hasMasterKey: true}))).toEqual([]);
    });

    it('leaves an Isle-only account alone until it reaches for something social', () => {
        expect(owedSteps(conditions({interests: [UserInterest.Isle]}))).toEqual([]);
    });

    it('ends the flow once the pick was Isle alone', () => {
        const before = owedSteps(conditions({onboarded: false, interests: undefined, passwordHeld: true}));
        const after = owedSteps(
            conditions({onboarded: true, interests: [UserInterest.Isle], passwordHeld: true}),
        );

        expect(before).toContain('recovery-code');
        expect(after).toEqual([]);
    });

    /**
     * A server predating the field sends no `interests`, and its users have always had key setup at
     * launch. Reading that absence as "Isle only" stops writing master keys for a whole deployment,
     * and the symptom does not surface until someone tries to restore.
     */
    it('treats an absent interests list as social', () => {
        expect(owedSteps(conditions({interests: undefined}))).toContain('recovery-code');
    });

    it('counts both halves of a pick as social', () => {
        const steps = owedSteps(conditions({interests: [UserInterest.Isle, UserInterest.Social]}));
        expect(steps).toContain('recovery-code');
    });
});
