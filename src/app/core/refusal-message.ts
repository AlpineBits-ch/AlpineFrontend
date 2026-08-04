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
 * Turns a policy refusal into something to say to the user (T0-2).
 *
 * <p>The API answers a refused conversation with `403` and a machine-readable code rather than the
 * old `400 "User cannot be added to conversation if not friends"`, precisely so the client can
 * tell "not allowed" from "malformed" and say the right thing.</p>
 *
 * <p><b>`blocked` and `recipient_dm_policy` deliberately read almost the same.</b> A refusal must
 * not become an oracle: if being blocked produced a distinctive message, anyone could discover
 * they had been blocked by trying to open a DM, which is exactly the state blocking is supposed to
 * keep private. `blocked` is only ever returned to the person who did the blocking; when the
 * *recipient* blocked you the server says `recipient_dm_policy`, identical to a Friends-only
 * refusal, and no amount of client cleverness should try to tell those apart.</p>
 *
 * <p><b>503 is not a denial.</b> `privacy_lookup_unavailable` means the policy data was unreachable
 * and the request was never actually decided. Reporting that as "you can't message this person"
 * would be a lie that outlives the outage - the user would stop trying. Any 503 from these routes
 * is treated this way regardless of the body, because the alternative is a body-parsing failure
 * silently downgrading to "denied".</p>
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
