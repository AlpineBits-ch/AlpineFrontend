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
 * A plain function rather than a computed: `passwordHeld` comes from a non-reactive field, so a
 * computed would cache a stale answer instead of tracking it.
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
