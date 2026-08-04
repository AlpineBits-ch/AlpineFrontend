import {HttpErrorResponse, HttpEvent, HttpInterceptorFn} from '@angular/common/http';
import {catchError, Observable, of, switchMap, throwError, timer} from 'rxjs';

/** How many times one request will wait out a 429 before the error is handed to the caller. */
const MAX_ATTEMPTS = 3;

/** A cap on any single wait. A server asking for minutes is answered with an error, not a hang. */
const MAX_WAIT_MS = 30_000;

/** Used when a 429 arrives with no parseable hint at all. */
const FALLBACK_WAIT_MS = 1_000;

/**
 * Spread added to every wait.
 *
 * <p>The bucket is global, so a 429 typically rejects a burst of requests at once and they would
 * otherwise all resume on the same millisecond and re-trigger it. The jitter is per request, which
 * is the point - a shared deadline with no spread is just a slower version of the same burst.</p>
 */
const JITTER_MS = 250;

/**
 * When the shared bucket is expected to have room again. Module-level because the server enforces
 * <b>one bucket per subject across every route</b>, so a 429 on any request is information about
 * every other one in flight.
 */
let gateOpensAt = 0;

/** Test seam. */
export function _resetRateLimitState(): void {
    gateOpensAt = 0;
}

/**
 * Reads how long to wait from a 429.
 *
 * <p><b>`retry_after` is fractional seconds.</b> `parseInt` on `0.42` yields `0` and turns a
 * deliberate pause into a hot retry loop against a bucket that is already empty, which is the
 * failure this parses carefully to avoid. The JSON body is preferred over the `Retry-After` header
 * because the header is whole seconds and rounds a 420ms wait up to a full one.</p>
 *
 * @returns milliseconds to wait, already clamped, or null when this is not a 429.
 */
export function parseRetryAfter(err: HttpErrorResponse): number | null {
    if (err.status !== 429) return null;

    const body = err.error as { retry_after?: unknown } | null;
    const fromBody = body && typeof body === 'object' ? Number(body.retry_after) : NaN;
    if (Number.isFinite(fromBody) && fromBody >= 0) return clampWait(fromBody * 1000);

    // Checked for presence before conversion: `Number(null)` and `Number('')` are both 0, which
    // would read a *missing* header as "retry immediately" and produce exactly the hot loop
    // against an empty bucket that this function exists to prevent.
    const raw = err.headers.get('Retry-After');
    if (raw !== null && raw.trim() !== '') {
        const header = Number(raw);
        if (Number.isFinite(header) && header >= 0) return clampWait(header * 1000);
    }

    return FALLBACK_WAIT_MS;
}

/**
 * Whether this 429 speaks for the whole bucket rather than one route.
 *
 * <p>Absent means yes: the gateway's limiter is global and a body that failed to parse should not
 * be read as "carry on hammering everything else".</p>
 */
function isGlobal(err: HttpErrorResponse): boolean {
    const body = err.error as { global?: unknown } | null;
    if (!body || typeof body !== 'object') return true;
    return body.global !== false;
}

function clampWait(ms: number): number {
    return Math.min(Math.max(ms, 0), MAX_WAIT_MS);
}

function jittered(ms: number): number {
    return ms + Math.random() * JITTER_MS;
}

/**
 * Backs off when the gateway rate-limits us (§8).
 *
 * <p>Two halves, and both are needed. The reactive half waits out a 429 and retries. The proactive
 * half holds <i>new</i> requests while a wait is in progress - without it, a cold start that fans
 * out across every guild answers one 429 by sending the other forty immediately, each earning its
 * own 429, and the app converges on the limit instead of backing away from it.</p>
 *
 * <p>Placed outermost so the waiting happens outside the per-request timeout: a backoff is not a
 * slow server, and charging it against the 30s budget would turn a successful retry into a
 * spurious timeout.</p>
 */
export const rateLimitInterceptor: HttpInterceptorFn = (req, next) => {
    const attempt = (n: number): Observable<HttpEvent<unknown>> =>
        waitForGate().pipe(
            switchMap(() => next(req)),
            catchError((err: unknown) => {
                if (!(err instanceof HttpErrorResponse)) return throwError(() => err);

                const wait = parseRetryAfter(err);
                if (wait === null) return throwError(() => err);

                if (isGlobal(err)) {
                    // Never move the gate earlier: a later 429 with a shorter hint would otherwise
                    // release requests that an earlier, longer one had correctly parked.
                    gateOpensAt = Math.max(gateOpensAt, Date.now() + wait);
                }

                if (n + 1 >= MAX_ATTEMPTS) return throwError(() => err);
                return timer(jittered(wait)).pipe(switchMap(() => attempt(n + 1)));
            }),
        );

    return attempt(0);
};

function waitForGate(): Observable<unknown> {
    const remaining = gateOpensAt - Date.now();
    return remaining > 0 ? timer(jittered(remaining)) : of(null);
}
