import {HttpErrorResponse} from '@angular/common/http';

/**
 * Classifies a send failure as an auto-mod refusal.
 *
 * Auto-mod refusals come back as a 403 with a structured body
 * `{ error: 'automod_blocked', reason: 'blocked_word' | 'rate_limited' }`. Ordinary permission
 * failures are also 403s but carry no such body, so only a 403 with `error: 'automod_blocked'`
 * counts — everything else (including other 403s) yields `null`.
 */
export function classifyAutoModError(err: HttpErrorResponse | null | undefined): 'blocked_word' | 'rate_limited' | null {
    if (!err || err.status !== 403) return null;
    const body = err.error as { error?: string; reason?: string } | null;
    if (body?.error !== 'automod_blocked') return null;
    return body.reason === 'rate_limited' ? 'rate_limited' : 'blocked_word';
}
