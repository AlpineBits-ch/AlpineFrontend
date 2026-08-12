import {HttpErrorResponse, HttpEvent, HttpInterceptorFn} from '@angular/common/http';
import {catchError, Observable, of, switchMap, throwError, timer} from 'rxjs';

/** How many times one request will wait out a 429 before the error is handed to the caller. */
const MAX_ATTEMPTS = 3;

/** A cap on any single wait. A server asking for minutes is answered with an error, not a hang. */
const MAX_WAIT_MS = 30_000;

/** Used when a 429 arrives with no parseable hint at all. */
const FALLBACK_WAIT_MS = 1_000;

/**
 * Smallest spread applied to a wait, for the case where the wait itself is tiny or zero.
 *
 * <p>The bucket is global, so a 429 typically rejects a burst of requests at once and they would
 * otherwise all resume on the same millisecond and re-trigger it. The jitter is per request, which
 * is the point - a shared deadline with no spread is just a slower version of the same burst.</p>
 */
const MIN_SPREAD_MS = 250;

/** Ceiling on the spread, so a long wait is not doubled by the jitter on top of it. */
const MAX_SPREAD_MS = 2_000;

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

/**
 * A wait, plus a spread scaled to that wait rather than a fixed tail.
 *
 * <p>A fixed 250ms spread was the wrong shape. The waits this handles are the ones the gateway
 * hands out when a whole first paint arrives at once, and a hundred parked requests released
 * inside a 250ms tail is 400 requests per second against a 50 per second bucket - the same burst
 * that earned the 429, one round later. Widening the landing zone to the length of the wait drops
 * that by the same factor the wait grows.</p>
 *
 * <p>Capped, because the spread is added on top of a wait that is already clamped to
 * {@link MAX_WAIT_MS}: without the cap a 30s gate could hold a request for a minute.</p>
 */
export function jittered(ms: number): number {
    const spread = Math.min(Math.max(ms, MIN_SPREAD_MS), MAX_SPREAD_MS);
    return ms + Math.random() * spread;
}

/** Backoff for the nth retry, so attempt three is not paced like attempt one. */
function backoff(wait: number, attempt: number): number {
    return clampWait(wait * 2 ** attempt);
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
    const attempt = (n: number, notBefore: number): Observable<HttpEvent<unknown>> =>
        waitUntil(notBefore).pipe(
            switchMap(() => next(req)),
            catchError((err: unknown) => {
                if (!(err instanceof HttpErrorResponse)) return throwError(() => err);

                const wait = parseRetryAfter(err);
                if (wait === null) return throwError(() => err);

                // Each further attempt backs off harder. Retrying a 429 at the same cadence turns
                // one logical request into MAX_ATTEMPTS real ones inside the same second, which is
                // amplification of the storm rather than relief from it.
                const delay = backoff(wait, n);

                if (isGlobal(err)) {
                    // Never move the gate earlier: a later 429 with a shorter hint would otherwise
                    // release requests that an earlier, longer one had correctly parked.
                    gateOpensAt = Math.max(gateOpensAt, Date.now() + delay);
                }

                if (n + 1 >= MAX_ATTEMPTS) return throwError(() => err);
                return attempt(n + 1, Date.now() + delay);
            }),
        );

    return attempt(0, 0);
};

/**
 * Holds until both the shared gate and this request's own resume time have passed.
 *
 * <p>Re-checked after every wait, which is the point. The old single check read the gate once and
 * committed to that deadline, so a request parked behind a 1s wait went out on schedule even if a
 * 429 arriving meanwhile had pushed the gate five seconds further out - the requests most likely
 * to be parked were exactly the ones released into a bucket that was known to be empty.</p>
 */
function waitUntil(notBefore: number): Observable<unknown> {
    const step = (): Observable<unknown> => {
        const remaining = Math.max(gateOpensAt, notBefore) - Date.now();
        if (remaining <= 0) return of(null);
        return timer(jittered(remaining)).pipe(switchMap(step));
    };
    return step();
}
