import {HttpErrorResponse} from '@angular/common/http';

/** One entry of the FluentValidation array the identity service returns for a 400. */
interface ValidationFailure {
    propertyName?: string | null;
    errorMessage?: string | null;
    errorCode?: string | null;
}

/**
 * A registration refusal, split into the form fields it belongs to.
 *
 * <p>The field values are translation keys. `general` holds the server's own sentences for failures
 * we have no localised copy for - it is empty for everything documented, and non-empty only when the
 * server grows a rule this client predates.</p>
 */
export interface RegistrationFieldErrors {
    username?: string;
    email?: string;
    birthdate?: string;
    general: string[];
}

/**
 * Routes a registration `400` onto the signup form.
 *
 * <p>Since the endpoint stopped distinguishing a free address from a taken one, a `400` no longer
 * means "that email is already registered" - it means the username, the address or the birth date
 * was unacceptable, and `propertyName` is what says which. Two of those do not name the field they
 * came from: the age check validates a bare date and reports an empty `propertyName`, and the email
 * format checks report `Value` because they come from the Email value object rather than the request
 * DTO. Both are matched on `errorCode` instead, which is why `errorCode` is read first.</p>
 *
 * <p>Everything else collapses to `general`, deliberately: reconstructing "the address is taken"
 * from any part of this response is the leak the contract change exists to close.</p>
 */
export function registrationFieldErrors(err: unknown): RegistrationFieldErrors {
    const result: RegistrationFieldErrors = {general: []};
    for (const failure of validationFailures(err)) {
        const property = failure.propertyName ?? '';
        const message = failure.errorMessage ?? '';

        switch (failure.errorCode) {
            case 'EmailInvalidFormat':
                result.email ??= 'LOGIN.REGISTER.EMAIL_INVALID';
                continue;
            case 'EmailDisposableNotAllowed':
                result.email ??= 'LOGIN.REGISTER.EMAIL_DISPOSABLE';
                continue;
            case 'LessThanValidator':
                result.birthdate ??= 'LOGIN.REGISTER.TOO_YOUNG';
                continue;
        }

        if (property === 'Username') {
            result.username ??= 'LOGIN.REGISTER.USERNAME_TAKEN';
        } else if (property === 'Email') {
            result.email ??= 'LOGIN.REGISTER.EMAIL_EMPTY';
        } else if (property === 'General') {
            // "Could not create the account." - a database failure or a lost race, with nothing the
            // user can act on. The caller's generic, localised message says the same thing better.
            continue;
        } else if (message) {
            result.general.push(message);
        }
    }
    return result;
}

/** True when at least one failure landed on a field the form can highlight. */
export function hasFieldError(errors: RegistrationFieldErrors): boolean {
    return !!(errors.username || errors.email || errors.birthdate);
}

function validationFailures(err: unknown): ValidationFailure[] {
    if (!(err instanceof HttpErrorResponse) || err.status !== 400) return [];
    const body = err.error;
    if (!Array.isArray(body)) return [];
    return body.filter((entry): entry is ValidationFailure => !!entry && typeof entry === 'object');
}
