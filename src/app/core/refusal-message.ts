import {HttpErrorResponse} from '@angular/common/http';
import {PRIVACY_REFUSAL_CODES} from '../models/privacy-settings.model';
import {refusalCode} from '../services/privacy-settings.service';

/**
 * Turns a policy refusal into something to say to the user (T0-2).
 *
 * <p>The API answers a refused conversation with `403` and a machine-readable code rather than the
 * old `400 "User cannot be added to conversation if not friends"`, precisely so the client can
 * tell "not allowed" from "malformed" and say the right thing.</p>
 *
 * <p><b>`blocked` and `recipient_dm_policy` deliberately read almost the same.</b> The spec's rule
 * is that a refusal must not become an oracle: if being blocked produced a distinctive message,
 * anyone could discover they had been blocked by trying to open a DM, which is exactly the state
 * blocking is supposed to keep private.</p>
 *
 * @returns a translation key, or null when this is not a policy refusal and the caller should fall
 *          back to its generic error handling.
 */
export function refusalMessageKey(err: unknown): string | null {
    if (!(err instanceof HttpErrorResponse) || err.status !== 403) return null;

    switch (refusalCode(err)) {
        case PRIVACY_REFUSAL_CODES.blocked:
            return 'MESSAGING.REFUSED_BLOCKED';
        case PRIVACY_REFUSAL_CODES.recipientDmPolicy:
            return 'MESSAGING.REFUSED_DM_POLICY';
        case PRIVACY_REFUSAL_CODES.friendRequestPolicy:
            return 'MESSAGING.REFUSED_FRIEND_REQUEST';
        default:
            return null;
    }
}
