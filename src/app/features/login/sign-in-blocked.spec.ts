import {signInBlocked} from './sign-in-blocked';

describe('signInBlocked', () => {
    it('reads the marker off an unparseable plain-text body', () => {
        // What Angular actually hands us: JSON.parse fails, the raw text survives on `.text`.
        const err = {
            status: 403,
            error: {error: new SyntaxError('bad json'), text: 'User is not allowed to sign in'},
        };
        expect(signInBlocked(err)).toEqual({reference: null});
    });

    it('reads it off a bare string body', () => {
        expect(signInBlocked({status: 403, error: 'User is not allowed to sign in'})).toEqual({
            reference: null,
        });
    });

    it('reads it off a quoted JSON string body', () => {
        expect(signInBlocked({status: 403, error: '"User is not allowed to sign in"'})).toEqual({
            reference: null,
        });
    });

    it('reads it off problem-details style fields', () => {
        expect(signInBlocked({status: 403, error: {detail: 'User is not allowed to sign in'}})).toEqual({
            reference: null,
        });
        expect(signInBlocked({status: 403, error: {message: 'user is not allowed to sign in.'}})).toEqual({
            reference: null,
        });
    });

    it("unwraps the OAuth library's nested reason", () => {
        const err = {reason: {status: 403, error: 'User is not allowed to sign in'}};
        expect(signInBlocked(err)).toEqual({reference: null});
    });

    it('picks up a reference code once the server sends one', () => {
        const err = {
            status: 403,
            error: {detail: 'User is not allowed to sign in', reference: 'vnt-2h4k9x7p'},
        };
        expect(signInBlocked(err)).toEqual({reference: 'VNT-2H4K9X7P'});
    });

    it('does not claim a ban on an ordinary 403, so email verification still runs', () => {
        expect(signInBlocked({status: 403, error: 'Email not confirmed'})).toBeNull();
        expect(signInBlocked({status: 403, error: null})).toBeNull();
        expect(signInBlocked({status: 403})).toBeNull();
    });

    it('ignores other statuses carrying the same words', () => {
        expect(signInBlocked({status: 401, error: 'User is not allowed to sign in'})).toBeNull();
    });

    it('survives a null or undefined error', () => {
        expect(signInBlocked(null)).toBeNull();
        expect(signInBlocked(undefined)).toBeNull();
    });
});
