import {HttpErrorResponse, HttpInterceptorFn, HttpRequest} from '@angular/common/http';
import {inject} from '@angular/core';
import {catchError, from, switchMap, throwError} from 'rxjs';
import {ApiConfigService} from '../services/api-config.service';
import {DeviceIdentityService} from '../services/device-identity.service';

/**
 * Stamps `X-Device-Id` on every API request. Must stay after `tokenInterceptor` in the chain so
 * the self-hosted base-URL rewrite has already happened when the `baseUrl()` guard runs.
 */
export const deviceIdInterceptor: HttpInterceptorFn = (req, next) => {
    const apiConfig = inject(ApiConfigService);
    if (!req.url.startsWith(apiConfig.baseUrl())) return next(req);

    const identity = inject(DeviceIdentityService);

    return from(identity.deviceId()).pipe(
        switchMap(deviceId => {
            const stamped = withDeviceId(req, deviceId);

            return next(stamped).pipe(
                catchError((err: unknown) => {
                    if (!isUnknownDeviceId(err) || isRegistrationRequest(req, apiConfig.baseUrl())) {
                        return throwError(() => err);
                    }

                    // One retry, no recursion: `next(...)` is not routed back through this
                    // interceptor.
                    return from(identity.ensureRegistered()).pipe(
                        switchMap(registered => registered
                            ? next(withDeviceId(req, deviceId))
                            : throwError(() => err)),
                    );
                }),
            );
        }),
    );
};

function withDeviceId(req: HttpRequest<unknown>, deviceId: string): HttpRequest<unknown> {
    return req.clone({setHeaders: {'X-Device-Id': deviceId}});
}

/** Matches the body, not just the status: a bare 400 covers far more than this case. */
function isUnknownDeviceId(err: unknown): boolean {
    if (!(err instanceof HttpErrorResponse) || err.status !== 400) return false;
    const body: unknown = err.error;
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
    return text.includes('Unknown X-Device-Id');
}

/** Re-registering in response to a failed registration would be circular. */
function isRegistrationRequest(req: HttpRequest<unknown>, baseUrl: string): boolean {
    return req.url.startsWith(`${baseUrl}/api/v1/identity/devices`);
}
