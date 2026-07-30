import {describe, expect, it} from 'vitest';
import {HttpErrorResponse} from '@angular/common/http';
import {classifyAutoModError} from './channel-utils';

function makeError(status: number, error: unknown): HttpErrorResponse {
    return new HttpErrorResponse({status, error});
}

describe('classifyAutoModError', () => {
    it('classifies a structured 403 with reason "rate_limited"', () => {
        const err = makeError(403, {error: 'automod_blocked', reason: 'rate_limited'});
        expect(classifyAutoModError(err)).toBe('rate_limited');
    });

    it('classifies a structured 403 with reason "blocked_word"', () => {
        const err = makeError(403, {error: 'automod_blocked', reason: 'blocked_word'});
        expect(classifyAutoModError(err)).toBe('blocked_word');
    });

    it('falls back to "blocked_word" for an unknown or missing reason', () => {
        const unknownReason = makeError(403, {error: 'automod_blocked', reason: 'something_new'});
        const missingReason = makeError(403, {error: 'automod_blocked'});
        expect(classifyAutoModError(unknownReason)).toBe('blocked_word');
        expect(classifyAutoModError(missingReason)).toBe('blocked_word');
    });

    it('returns null for a bare 403 with no body', () => {
        const err = makeError(403, null);
        expect(classifyAutoModError(err)).toBeNull();
    });

    it('returns null for a 403 with a different error marker (ordinary permission failure)', () => {
        const err = makeError(403, {error: 'forbidden'});
        expect(classifyAutoModError(err)).toBeNull();
    });

    it('returns null for a non-403 error', () => {
        const err = makeError(500, {error: 'automod_blocked', reason: 'blocked_word'});
        expect(classifyAutoModError(err)).toBeNull();
    });

    it('returns null when given null or undefined', () => {
        expect(classifyAutoModError(null)).toBeNull();
        expect(classifyAutoModError(undefined)).toBeNull();
    });
});
