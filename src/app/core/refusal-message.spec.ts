import {describe, expect, it} from 'vitest';
import {HttpErrorResponse} from '@angular/common/http';
import {refusalMessageKey} from './refusal-message';

function forbidden(body: unknown): HttpErrorResponse {
    return new HttpErrorResponse({status: 403, statusText: 'Forbidden', error: body});
}

describe('refusalMessageKey', () => {
    it('maps a recipient DM policy refusal', () => {
        expect(refusalMessageKey(forbidden({code: 'recipient_dm_policy'})))
            .toBe('MESSAGING.REFUSED_DM_POLICY');
    });

    it('maps a block refusal', () => {
        expect(refusalMessageKey(forbidden({code: 'blocked'}))).toBe('MESSAGING.REFUSED_BLOCKED');
    });

    it('maps a friend-request policy refusal', () => {
        expect(refusalMessageKey(forbidden({code: 'friend_request_policy'})))
            .toBe('MESSAGING.REFUSED_FRIEND_REQUEST');
    });

    it('reads the code from errorCode as well as code', () => {
        expect(refusalMessageKey(forbidden({errorCode: 'blocked'}))).toBe('MESSAGING.REFUSED_BLOCKED');
    });

    it('returns null for a 403 with no recognised code, so the caller falls back', () => {
        expect(refusalMessageKey(forbidden({code: 'something_else'}))).toBeNull();
        expect(refusalMessageKey(forbidden(null))).toBeNull();
    });

    it('returns null for statuses other than 403', () => {
        const notFound = new HttpErrorResponse({status: 404, error: {code: 'blocked'}});
        expect(refusalMessageKey(notFound)).toBeNull();
    });

    it('returns null for a non-HTTP error', () => {
        expect(refusalMessageKey(new Error('boom'))).toBeNull();
        expect(refusalMessageKey(undefined)).toBeNull();
    });
});
