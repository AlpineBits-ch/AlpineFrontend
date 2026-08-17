import {HttpErrorResponse, HttpEvent, HttpInterceptorFn} from '@angular/common/http';
import {catchError, Observable, of, switchMap, throwError, timer} from 'rxjs';

/** How many times one request will wait out a 429 before the error is handed to the caller. */
const MAX_ATTEMPTS = 3;

/** A cap on any single wait. A server asking for minutes is answered with an error, not a hang. */
const MAX_WAIT_MS = 30_000;

/** Used when a 429 arrives with no parseable hint at all. */
const FALLBACK_WAIT_MS = 1_000;

/** Smallest spread applied to a wait, for the case where the wait itself is tiny or zero. */
const MIN_SPREAD_MS = 250;

/** Ceiling on the spread, so a long wait is not doubled by the jitter on top of it. */
const MAX_SPREAD_MS = 2_000;

/** When the shared bucket is expected to have room again. One bucket per subject, all routes. */
let gateOpensAt = 0;

/** Test seam. */
export function _resetRateLimitState(): void {
    gateOpensAt = 0;
}

/**
 * Reads how long to wait from a 429. `retry_after` is fractional seconds, so never `parseInt` it.
 *
 * @returns milliseconds to wait, already clamped, or null when this is not a 429.
 */
export function parseRetryAfter(err: HttpErrorResponse): number | null {
    if (err.status !== 429) return null;

    const body = err.error as {retry_after?: unknown} | null;
    const fromBody = body && typeof body === 'object' ? Number(body.retry_after) : NaN;
    if (Number.isFinite(fromBody) && fromBody >= 0) return clampWait(fromBody * 1000);

    // Checked for presence before conversion: `Number(null)` and `Number('')` are both 0, which
    // would read a missing header as "retry immediately".
    const raw = err.headers.get('Retry-After');
    if (raw !== null && raw.trim() !== '') {
        const header = Number(raw);
        if (Number.isFinite(header) && header >= 0) return clampWait(header * 1000);
    }

    return FALLBACK_WAIT_MS;
}

/** Whether this 429 speaks for the whole bucket rather than one route. Absent means yes. */
function isGlobal(err: HttpErrorResponse): boolean {
    const body = err.error as {global?: unknown} | null;
    if (!body || typeof body !== 'object') return true;
    return body.global !== false;
}

function clampWait(ms: number): number {
    return Math.min(Math.max(ms, 0), MAX_WAIT_MS);
}

/** A wait, plus a spread scaled to that wait and capped so it cannot double an already-long wait. */
export function jittered(ms: number): number {
    const spread = Math.min(Math.max(ms, MIN_SPREAD_MS), MAX_SPREAD_MS);
    return ms + Math.random() * spread;
}

/** Backoff for the nth retry, so attempt three is not paced like attempt one. */
function backoff(wait: number, attempt: number): number {
    return clampWait(wait * 2 ** attempt);
}

/**
 * Backs off when the gateway rate-limits us (§8). Must stay outermost in the interceptor chain so
 * the waiting happens outside the per-request timeout.
 */
export const rateLimitInterceptor: HttpInterceptorFn = (req, next) => {
    const attempt = (n: number, notBefore: number): Observable<HttpEvent<unknown>> =>
        waitUntil(notBefore).pipe(
            switchMap(() => next(req)),
            catchError((err: unknown) => {
                if (!(err instanceof HttpErrorResponse)) return throwError(() => err);

                const wait = parseRetryAfter(err);
                if (wait === null) return throwError(() => err);

                // Each further attempt backs off harder.
                const delay = backoff(wait, n);

                if (isGlobal(err)) {
                    // Never move the gate earlier.
                    gateOpensAt = Math.max(gateOpensAt, Date.now() + delay);
                }

                if (n + 1 >= MAX_ATTEMPTS) return throwError(() => err);
                return attempt(n + 1, Date.now() + delay);
            }),
        );

    return attempt(0, 0);
};

/** Holds until both the shared gate and this request's own resume time have passed, re-checking
 * the gate after every wait. */
function waitUntil(notBefore: number): Observable<unknown> {
    const step = (): Observable<unknown> => {
        const remaining = Math.max(gateOpensAt, notBefore) - Date.now();
        if (remaining <= 0) return of(null);
        return timer(jittered(remaining)).pipe(switchMap(step));
    };
    return step();
}
