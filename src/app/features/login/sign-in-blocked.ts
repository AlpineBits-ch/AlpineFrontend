/** Telling "your account is restricted" apart from "your email is not confirmed". */

/** The server's sentence, matched case- and punctuation-insensitively. */
const MARKER = 'user is not allowed to sign in';

interface MaybeHttpError {
    status?: number;
    error?: unknown;
    reason?: { status?: number; error?: unknown };
}

export interface SignInBlocked {
    /** `VNT-XXXXXXXX`, once the server sends it. Null until then, and the screen omits it. */
    reference: string | null;
}

/** Pulls every plausible carrier of the marker out of an error body. */
function candidateTexts(body: unknown): string[] {
    if (typeof body === 'string') return [body];
    if (!body || typeof body !== 'object') return [];

    const o = body as Record<string, unknown>;
    return [o['text'], o['detail'], o['title'], o['message'], o['error'], o['error_description']]
        .filter((v): v is string => typeof v === 'string');
}

function readReference(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const o = body as Record<string, unknown>;
    for (const key of ['reference', 'referenceCode', 'reference_code']) {
        const value = o[key];
        if (typeof value === 'string' && value.trim()) return value.trim().toUpperCase();
    }
    return null;
}

/**
 * Classifies a failed token request as a restricted account.
 *
 * @returns null when this 403 is something else - an unconfirmed email, most often - and the
 *          caller must fall back to its existing handling rather than accusing the user of a ban.
 */
export function signInBlocked(err: unknown): SignInBlocked | null {
    const e = (err ?? {}) as MaybeHttpError;
    if ((e.status ?? e.reason?.status) !== 403) return null;

    const body = e.error ?? e.reason?.error;
    const matched = candidateTexts(body).some(text =>
        text.trim().replace(/^"|"$/g, '').replace(/\.$/, '').toLowerCase() === MARKER
    );
    if (!matched) return null;

    return {reference: readReference(body)};
}
