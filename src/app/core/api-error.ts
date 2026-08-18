import {HttpErrorResponse} from '@angular/common/http';

/**
 * The sentence the API sent with a refusal, out of whichever envelope it used: the house
 * `{error, message}` shape, a ProblemDetails, a `ValidationProblem` dictionary, or a bare JSON
 * string. Returns null when the body carries nothing worth showing, so callers keep their own
 * wording.
 */
export function apiErrorMessage(err: unknown): string | null {
    if (!(err instanceof HttpErrorResponse)) return null;

    const body = err.error;
    if (typeof body === 'string') return clean(body);
    if (!body || typeof body !== 'object') return null;

    const shape = body as {
        message?: unknown;
        detail?: unknown;
        title?: unknown;
        errors?: unknown;
    };

    for (const candidate of [shape.message, shape.detail, shape.title]) {
        const text = clean(candidate);
        if (text) return text;
    }

    if (shape.errors && typeof shape.errors === 'object') {
        const first = Object.values(shape.errors as Record<string, unknown>)
            .flatMap(value => (Array.isArray(value) ? value : [value]))
            .map(clean)
            .find(text => !!text);
        if (first) return first;
    }

    return null;
}

function clean(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    // A JSON body of just `"..."` reaches us with the quotes still on it.
    const unquoted = text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1).trim() : text;
    return unquoted.length > 0 ? unquoted : null;
}
