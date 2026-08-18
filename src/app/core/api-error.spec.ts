import {describe, expect, it} from 'vitest';
import {HttpErrorResponse} from '@angular/common/http';
import {apiErrorMessage} from './api-error';

function response(body: unknown, status = 400): HttpErrorResponse {
    return new HttpErrorResponse({error: body, status});
}

describe('apiErrorMessage', () => {
    it('reads the house {error, message} shape', () => {
        const body = {
            error: 'turn_order_not_in_cast',
            message: 'The turn order can only name personas in the scene.',
        };
        expect(apiErrorMessage(response(body))).toBe('The turn order can only name personas in the scene.');
    });

    it('reads a ProblemDetails detail, then its title', () => {
        expect(apiErrorMessage(response({title: 'Bad Request', detail: 'No.'}))).toBe('No.');
        expect(apiErrorMessage(response({title: 'Bad Request'}))).toBe('Bad Request');
    });

    it('reads the first message of a ValidationProblem', () => {
        const body = {errors: {Name: ['A name is required.', 'Too long.']}};
        expect(apiErrorMessage(response(body))).toBe('A name is required.');
    });

    it('strips the quotes a bare JSON string body arrives with', () => {
        expect(apiErrorMessage(response('"That persona is not in this scene."'))).toBe(
            'That persona is not in this scene.',
        );
    });

    it('gives up on a body with nothing to show, so the caller keeps its own wording', () => {
        expect(apiErrorMessage(response({error: 'rate_limited'}))).toBeNull();
        expect(apiErrorMessage(response({}))).toBeNull();
        expect(apiErrorMessage(response('  '))).toBeNull();
        expect(apiErrorMessage(new Error('boom'))).toBeNull();
    });
});
