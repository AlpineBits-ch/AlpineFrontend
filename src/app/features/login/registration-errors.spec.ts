import {describe, expect, it} from 'vitest';
import {HttpErrorResponse} from '@angular/common/http';
import {hasFieldError, registrationFieldErrors} from './registration-errors';

/** The FluentValidation array shape the identity service returns for a 400. */
function refused(...failures: Partial<Record<string, unknown>>[]): HttpErrorResponse {
    return new HttpErrorResponse({
        status: 400,
        statusText: 'Bad Request',
        error: failures.map(f => ({
            propertyName: null,
            errorMessage: null,
            attemptedValue: null,
            customState: null,
            severity: 'Error',
            errorCode: null,
            formattedMessagePlaceholderValues: null,
            ...f,
        })),
    });
}

describe('registrationFieldErrors', () => {
    it('routes a taken username to the username field', () => {
        const errors = registrationFieldErrors(refused({
            propertyName: 'Username',
            errorMessage: 'That username is already taken.',
        }));
        expect(errors.username).toBe('LOGIN.REGISTER.USERNAME_TAKEN');
        expect(errors.general).toEqual([]);
    });

    it('routes a blank email to the email field', () => {
        const errors = registrationFieldErrors(refused({
            propertyName: 'Email',
            errorMessage: 'Email cannot be empty',
        }));
        expect(errors.email).toBe('LOGIN.REGISTER.EMAIL_EMPTY');
    });

    // The email checks come from the Email value object, so they report `Value` rather than the name
    // of the field the user is looking at. Matching on the property name alone would drop both.
    it('routes a malformed email reported as `Value` to the email field', () => {
        const errors = registrationFieldErrors(refused({
            propertyName: 'Value',
            errorMessage: 'Invalid email format',
            errorCode: 'EmailInvalidFormat',
        }));
        expect(errors.email).toBe('LOGIN.REGISTER.EMAIL_INVALID');
        expect(errors.general).toEqual([]);
    });

    it('routes a disposable email domain to the email field', () => {
        const errors = registrationFieldErrors(refused({
            propertyName: 'Value',
            errorMessage: 'One-time or disposable email addresses are not allowed.',
            errorCode: 'EmailDisposableNotAllowed',
        }));
        expect(errors.email).toBe('LOGIN.REGISTER.EMAIL_DISPOSABLE');
    });

    // The age rule validates a bare date, so there is no property name to report at all.
    it('routes the under-13 failure to the birth date field despite an empty propertyName', () => {
        const errors = registrationFieldErrors(refused({
            propertyName: '',
            errorMessage: 'Age must be greater than 13',
            errorCode: 'LessThanValidator',
        }));
        expect(errors.birthdate).toBe('LOGIN.REGISTER.TOO_YOUNG');
        expect(errors.general).toEqual([]);
    });

    // "Could not create the account." is a database failure or a lost race - nothing the user can
    // act on, and the caller has a localised sentence that says so better than the server's does.
    it('leaves a General failure for the caller to render generically', () => {
        const errors = registrationFieldErrors(refused({
            propertyName: 'General',
            errorMessage: 'Could not create the account.',
        }));
        expect(hasFieldError(errors)).toBe(false);
        expect(errors.general).toEqual([]);
    });

    it('carries an unrecognised failure through verbatim', () => {
        const errors = registrationFieldErrors(refused({
            propertyName: 'Password',
            errorMessage: 'Password must contain a digit.',
        }));
        expect(errors.general).toEqual(['Password must contain a digit.']);
        expect(hasFieldError(errors)).toBe(false);
    });

    it('routes every failure in a multi-entry body', () => {
        const errors = registrationFieldErrors(refused(
            {propertyName: 'Username', errorMessage: 'That username is already taken.'},
            {propertyName: '', errorMessage: 'Age must be greater than 13', errorCode: 'LessThanValidator'},
        ));
        expect(errors.username).toBe('LOGIN.REGISTER.USERNAME_TAKEN');
        expect(errors.birthdate).toBe('LOGIN.REGISTER.TOO_YOUNG');
        expect(hasFieldError(errors)).toBe(true);
    });

    // A 202 is the answer for a free address and a taken one alike, so nothing below may be read as
    // "that email is registered" - there is no status left that means it.
    it('finds nothing to route on a 500, a non-array body, or a non-HTTP error', () => {
        const serverFault = new HttpErrorResponse({status: 500, error: 'boom'});
        expect(registrationFieldErrors(serverFault)).toEqual({general: []});
        expect(registrationFieldErrors(new HttpErrorResponse({status: 400, error: {message: 'nope'}})))
            .toEqual({general: []});
        expect(registrationFieldErrors(new Error('offline'))).toEqual({general: []});
        expect(registrationFieldErrors(null)).toEqual({general: []});
    });
});
