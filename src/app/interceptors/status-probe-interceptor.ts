import {HttpErrorResponse, HttpInterceptorFn} from '@angular/common/http';
import {inject} from '@angular/core';
import {catchError, throwError} from 'rxjs';
import {PlatformStatusService} from '../services/platform-status.service';
import {isAnonymousStatusUrl} from '../services/status-api.service';

/**
 * The moment platform status is actually worth something: the user is looking at a broken screen
 * and deciding whether to blame their wifi.
 *
 * <p>Fetches the summary once, out of band, when the app cannot reach the API at all or the gateway
 * itself answers - and on any 5xx from the token endpoint, which is "sign-in failed with a 5xx"
 * without {@link import('../services/auth.service').AuthService} having to know this feature
 * exists. (It cannot: `AuthService` is upstream of the realtime connection that
 * {@link PlatformStatusService} watches, so injecting one into the other closes a cycle.)</p>
 *
 * <p>Ordinary 4xx and application-level 500s are left alone. A single failing endpoint is not an
 * incident, and probing on every one of them would mean a status call per failed request.</p>
 */
export const statusProbeInterceptor: HttpInterceptorFn = (req, next) => {
    // The status endpoint failing must not trigger a fetch of the status endpoint.
    if (isAnonymousStatusUrl(req.url)) return next(req);

    const status = inject(PlatformStatusService);

    return next(req).pipe(
        catchError((err: unknown) => {
            if (err instanceof HttpErrorResponse && isWorthProbing(req.url, err.status)) {
                status.probe();
            }
            return throwError(() => err);
        }),
    );
};

/**
 * `0` is a network error - DNS, offline, TLS, connection refused - which is also what a client
 * with no connection at all sees, and the summary call failing too is how that resolves itself.
 */
function isWorthProbing(url: string, httpStatus: number): boolean {
    if (httpStatus === 0) return true;
    if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) return true;
    return url.includes('connect/token') && httpStatus >= 500;
}
