import {describe, expect, it} from 'vitest';
import {HttpErrorResponse} from '@angular/common/http';
import {describeRefusal, refusalMessageKey} from './refusal-message';

function forbidden(body: unknown): HttpErrorResponse {
    return new HttpErrorResponse({status: 403, statusText: 'Forbidden', error: body});
}

describe('refusalMessageKey', () => {
    // The conversation, messaging and voice routes send `{error: "..."}` while the friend-request
    // and settings routes send `{code: "..."}`. Both families must resolve, because reading only
    // one silently turns every refusal in the other back into an unexplained failure.
    it('reads the code from the `error` field the messaging routes use', () => {
        expect(refusalMessageKey(forbidden({error: 'recipient_dm_policy', userId: 'user_1'})))
            .toBe('MESSAGING.REFUSED_DM_POLICY');
    });

    it('reads the code from the `code` field the friend-request routes use', () => {
        expect(refusalMessageKey(forbidden({code: 'friend_request_policy'})))
            .toBe('MESSAGING.REFUSED_FRIEND_REQUEST');
    });

    it('maps a recipient DM policy refusal', () => {
        expect(refusalMessageKey(forbidden({code: 'recipient_dm_policy'})))
            .toBe('MESSAGING.REFUSED_DM_POLICY');
    });

    it('maps a block refusal', () => {
        expect(refusalMessageKey(forbidden({error: 'blocked'}))).toBe('MESSAGING.REFUSED_BLOCKED');
    });

    it('maps an explicit-content refusal', () => {
        expect(refusalMessageKey(forbidden({error: 'explicit_content_filtered'})))
            .toBe('MESSAGING.REFUSED_EXPLICIT_CONTENT');
    });

    it('reads the code from errorCode as well', () => {
        expect(refusalMessageKey(forbidden({errorCode: 'blocked'}))).toBe('MESSAGING.REFUSED_BLOCKED');
    });

    it('returns null for a 403 with no recognised code, so the caller falls back', () => {
        expect(refusalMessageKey(forbidden({code: 'something_else'}))).toBeNull();
        expect(refusalMessageKey(forbidden(null))).toBeNull();
    });

    it('returns null for a non-HTTP error', () => {
        expect(refusalMessageKey(new Error('boom'))).toBeNull();
        expect(refusalMessageKey(undefined)).toBeNull();
    });
});

describe('describeRefusal', () => {
    it('treats a policy refusal as final', () => {
        expect(describeRefusal(forbidden({error: 'blocked'})))
            .toEqual({messageKey: 'MESSAGING.REFUSED_BLOCKED', retryable: false});
    });

    // A 503 means the policy data was unreachable, so nothing was actually decided. Reporting it
    // as a denial is a lie that outlives the outage - the user stops trying.
    it('treats a 503 as retryable rather than as a denial', () => {
        const unavailable = new HttpErrorResponse({
            status: 503, error: {error: 'privacy_lookup_unavailable'},
        });
        expect(describeRefusal(unavailable))
            .toEqual({messageKey: 'MESSAGING.REFUSED_LOOKUP_UNAVAILABLE', retryable: true});
    });

    it('treats any 503 that way, even with an unparseable body', () => {
        // Depending on the body would let a shape change downgrade "unknown" to "denied", which is
        // the one direction this must never fail in.
        const unavailable = new HttpErrorResponse({status: 503, error: 'gateway is down'});
        expect(describeRefusal(unavailable)?.retryable).toBe(true);
    });

    it('ignores statuses that are neither 403 nor 503', () => {
        expect(describeRefusal(new HttpErrorResponse({status: 404, error: {code: 'blocked'}})))
            .toBeNull();
    });
});
