import {HttpErrorResponse} from '@angular/common/http';

/** One entry of the FluentValidation array the identity service returns for a 400. */
interface ValidationFailure {
    propertyName?: string | null;
    errorMessage?: string | null;
    errorCode?: string | null;
}

/** A registration refusal, split into the form fields it belongs to. */
export interface RegistrationFieldErrors {
    username?: string;
    email?: string;
    birthdate?: string;
    general: string[];
}

/** Routes a registration `400` onto the signup form. */
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
