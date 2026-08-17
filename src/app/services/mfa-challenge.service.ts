import {Injectable, signal} from '@angular/core';

export type MfaErrorKind = 'required' | 'invalid';

interface MaybeHttpError {
    status?: number;
    error?: unknown;
    reason?: {status?: number; error?: unknown};
}

/**
 * Classifies a failed token request as an MFA challenge.
 *
 * The backend answers with `StatusCode(401, "mfa_required")`, i.e. a bare string body.
 * Angular's HttpClient parses responses as JSON by default, so an unquoted string body
 * fails to parse and surfaces as `{error: SyntaxError, text: 'mfa_required'}`. Depending on
 * content negotiation the same marker can also arrive as a plain string or a quoted JSON
 * string, so all three shapes are accepted here. A 401 without a marker is an ordinary
 * bad-credentials failure and must NOT show a code prompt.
 */
export function mfaErrorKind(err: unknown): MfaErrorKind | null {
    const e = (err ?? {}) as MaybeHttpError;
    const status = e.status ?? e.reason?.status;
    if (status !== 401) return null;

    const body = e.error ?? e.reason?.error;
    let text: string | null = null;
    if (typeof body === 'string') text = body;
    else if (body && typeof body === 'object' && typeof (body as {text?: unknown}).text === 'string') {
        text = (body as {text: string}).text;
    }
    if (!text) return null;

    const normalized = text.trim().replace(/^"|"$/g, '');
    if (normalized === 'mfa_required') return 'required';
    if (normalized === 'mfa_invalid') return 'invalid';
    return null;
}

@Injectable({providedIn: 'root'})
export class MfaChallengeService {
    readonly visible = signal(false);
    readonly username = signal('');
    readonly password = signal('');

    show(username: string, password: string): void {
        this.username.set(username);
        this.password.set(password);
        this.visible.set(true);
    }

    dismiss(): void {
        this.visible.set(false);
        this.username.set('');
        this.password.set('');
    }
}
