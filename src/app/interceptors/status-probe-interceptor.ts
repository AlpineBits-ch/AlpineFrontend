import {HttpErrorResponse, HttpInterceptorFn} from '@angular/common/http';
import {inject} from '@angular/core';
import {catchError, throwError} from 'rxjs';
import {PlatformStatusService} from '../services/platform-status.service';
import {isAnonymousStatusUrl} from '../services/status-api.service';

/**
 * Fetches the platform status summary out of band when the app cannot reach the API at all, the
 * gateway itself answers, or the token endpoint 5xxs. Ordinary 4xx and 500s are left alone.
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

/** `0` is a network error: DNS, offline, TLS, or connection refused. */
function isWorthProbing(url: string, httpStatus: number): boolean {
    if (httpStatus === 0) return true;
    if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) return true;
    return url.includes('connect/token') && httpStatus >= 500;
}
