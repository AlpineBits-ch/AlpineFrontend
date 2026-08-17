import {mfaErrorKind} from './mfa-challenge.service';

describe('mfaErrorKind', () => {
    // The backend returns these as a bare string body via StatusCode(401, "mfa_required"),
    // which Angular's JSON-by-default HttpClient fails to parse - so the marker can arrive
    // either as `error` (string) or nested under `error.text` after the parse failure.
    it('detects mfa_required from a plain string body', () => {
        expect(mfaErrorKind({status: 401, error: 'mfa_required'})).toBe('required');
    });

    it('detects mfa_required from a failed-JSON-parse body', () => {
        expect(mfaErrorKind({status: 401, error: {text: 'mfa_required'}})).toBe('required');
    });

    it('detects a quoted JSON string body', () => {
        expect(mfaErrorKind({status: 401, error: '"mfa_invalid"'})).toBe('invalid');
    });

    it('returns null for a plain 401 with no marker', () => {
        expect(mfaErrorKind({status: 401, error: null})).toBeNull();
    });

    it('returns null for non-401 statuses', () => {
        expect(mfaErrorKind({status: 403, error: 'mfa_required'})).toBeNull();
    });

    it('unwraps the OAuth library reason wrapper', () => {
        expect(mfaErrorKind({reason: {status: 401, error: 'mfa_required'}})).toBe('required');
    });
});
