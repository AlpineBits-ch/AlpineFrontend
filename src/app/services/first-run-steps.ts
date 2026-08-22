import {UserInterest} from '../dtos/response/UserDto';

export type FirstRunStep = 'pick' | 'password' | 'recovery-code';

export interface FirstRunConditions {
    onboarded: boolean;
    /** Absent from a server built before the field existed. */
    interests: UserInterest[] | undefined;
    hasMasterKey: boolean;
    passwordHeld: boolean;
}

/**
 * Which first-run steps this account still owes, in the order they are shown.
 *
 * `passwordHeld` comes from a non-reactive field, so the answer has to be recomputed on every read.
 */
export function owedSteps(conditions: FirstRunConditions): FirstRunStep[] {
    const steps: FirstRunStep[] = [];

    if (!conditions.onboarded) steps.push('pick');

    if (!conditions.hasMasterKey && wantsSocial(conditions.interests)) {
        if (!conditions.passwordHeld) steps.push('password');
        steps.push('recovery-code');
    }

    return steps;
}

/** An older server sends no interests, and every one of its accounts has always owed a key. */
function wantsSocial(interests: UserInterest[] | undefined): boolean {
    if (!interests) return true;
    return interests.includes(UserInterest.Social);
}
