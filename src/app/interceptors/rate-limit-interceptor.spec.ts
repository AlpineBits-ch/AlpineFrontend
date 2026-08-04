import {beforeEach, describe, expect, it} from 'vitest';
import {HttpErrorResponse, HttpHeaders} from '@angular/common/http';
import {_resetRateLimitState, parseRetryAfter} from './rate-limit-interceptor';

function tooManyRequests(body: unknown, headers?: Record<string, string>): HttpErrorResponse {
    return new HttpErrorResponse({
        status: 429,
        statusText: 'Too Many Requests',
        error: body,
        headers: headers ? new HttpHeaders(headers) : undefined,
    });
}

describe('parseRetryAfter', () => {
    beforeEach(() => _resetRateLimitState());

    /**
     * The headline trap in the contract: `retry_after` is fractional seconds. `parseInt('0.42')`
     * is 0, which turns a deliberate pause into a hot retry loop against an empty bucket - the
     * client hammering hardest is exactly the one that was already over the limit.
     */
    it('keeps the fractional part of retry_after', () => {
        expect(parseRetryAfter(tooManyRequests({retry_after: 0.42, global: true}))).toBe(420);
    });

    it('does not round a sub-second wait down to nothing', () => {
        expect(parseRetryAfter(tooManyRequests({retry_after: 0.05}))).toBeGreaterThan(0);
    });

    it('handles whole-second values', () => {
        expect(parseRetryAfter(tooManyRequests({retry_after: 2}))).toBe(2000);
    });

    // The body is preferred over the header because the header is whole seconds and rounds a
    // 420ms wait up to a full one.
    it('falls back to the Retry-After header when the body has no hint', () => {
        expect(parseRetryAfter(tooManyRequests({}, {'Retry-After': '3'}))).toBe(3000);
    });

    it('prefers the fractional body value over the rounded header', () => {
        expect(parseRetryAfter(tooManyRequests({retry_after: 0.5}, {'Retry-After': '1'}))).toBe(500);
    });

    it('falls back to a default when nothing is parseable', () => {
        expect(parseRetryAfter(tooManyRequests('rate limited'))).toBe(1000);
        expect(parseRetryAfter(tooManyRequests(null))).toBe(1000);
    });

    // A server asking us to sit out several minutes gets an error handed to the caller instead of
    // a UI that appears to hang.
    it('clamps an absurd wait', () => {
        expect(parseRetryAfter(tooManyRequests({retry_after: 600}))).toBe(30_000);
    });

    it('treats a zero wait as immediate rather than as missing', () => {
        expect(parseRetryAfter(tooManyRequests({retry_after: 0}))).toBe(0);
    });

    it('ignores a negative wait', () => {
        expect(parseRetryAfter(tooManyRequests({retry_after: -5}))).toBe(1000);
    });

    it('returns null for anything that is not a 429', () => {
        expect(parseRetryAfter(new HttpErrorResponse({status: 500}))).toBeNull();
        expect(parseRetryAfter(new HttpErrorResponse({status: 403, error: {retry_after: 1}})))
            .toBeNull();
    });
});
