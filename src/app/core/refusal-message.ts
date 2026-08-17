import {HttpErrorResponse} from '@angular/common/http';
import {PRIVACY_REFUSAL_CODES} from '../models/privacy-settings.model';
import {refusalCode} from '../services/privacy-settings.service';

/** What to tell the user, and whether trying again could plausibly work. */
export interface RefusalNotice {
    messageKey: string;
    /**
     * True when the server could not reach the policy data, so it never decided. The caller should
     * offer a retry rather than reporting a denial - see {@link describeRefusal}.
     */
    retryable: boolean;
}

/**
 * Turns a policy refusal into something to say to the user (T0-2). `blocked` and
 * `recipient_dm_policy` must keep reading almost the same, so a refusal is never a block oracle.
 * A 503 is retryable, never a denial.
 *
 * @returns null when this is not a policy refusal and the caller should fall back to its generic
 *          error handling.
 */
export function describeRefusal(err: unknown): RefusalNotice | null {
    if (!(err instanceof HttpErrorResponse)) return null;

    if (err.status === 503) {
        return {messageKey: 'MESSAGING.REFUSED_LOOKUP_UNAVAILABLE', retryable: true};
    }
    if (err.status !== 403) return null;

    switch (refusalCode(err)) {
        case PRIVACY_REFUSAL_CODES.blocked:
            return {messageKey: 'MESSAGING.REFUSED_BLOCKED', retryable: false};
        case PRIVACY_REFUSAL_CODES.recipientDmPolicy:
            return {messageKey: 'MESSAGING.REFUSED_DM_POLICY', retryable: false};
        case PRIVACY_REFUSAL_CODES.explicitContentFiltered:
            return {messageKey: 'MESSAGING.REFUSED_EXPLICIT_CONTENT', retryable: false};
        case PRIVACY_REFUSAL_CODES.friendRequestPolicy:
            return {messageKey: 'MESSAGING.REFUSED_FRIEND_REQUEST', retryable: false};
        default:
            return null;
    }
}

/** Convenience for the call sites that only want the string. */
export function refusalMessageKey(err: unknown): string | null {
    return describeRefusal(err)?.messageKey ?? null;
}
