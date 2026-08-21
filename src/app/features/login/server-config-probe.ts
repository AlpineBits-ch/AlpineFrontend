import {HttpErrorResponse} from '@angular/common/http';
import {MonoTypeOperatorFunction, retry, throwError, timer} from 'rxjs';

/** Attempts in total, not retries on top of one. */
const ATTEMPTS = 3;
const BACKOFF_MS = 400;

/**
 * Rides out a cold start.
 *
 * <p>The probe runs once, from the login card's constructor, and a single failure leaves the card
 * red until the instance is changed.</p>
 */
export function retryTransient<T>(): MonoTypeOperatorFunction<T> {
    return retry({
        count: ATTEMPTS - 1,
        delay: (err: unknown, attempt: number) =>
            isTransient(err) ? timer(BACKOFF_MS * attempt) : throwError(() => err),
    });
}

/** `0` is no answer at all: DNS, TLS, CORS, offline, or the request timing out. */
export function isTransient(err: unknown): boolean {
    return err instanceof HttpErrorResponse && (err.status === 0 || err.status >= 500);
}

/** Status `0` means the request never reached the instance, so the two sides can be told apart. */
export function describeProbeFailure(err: unknown): string {
    return err instanceof HttpErrorResponse ? `status ${err.status} ${err.statusText}` : String(err);
}
