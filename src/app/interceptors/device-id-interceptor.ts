import {HttpErrorResponse, HttpInterceptorFn, HttpRequest} from '@angular/common/http';
import {inject} from '@angular/core';
import {catchError, from, switchMap, throwError} from 'rxjs';
import {ApiConfigService} from '../services/api-config.service';
import {DeviceIdentityService} from '../services/device-identity.service';

/**
 * Stamps `X-Device-Id` on every API request.
 *
 * The backend validates the header on call accept/decline/leave, the Cloudflare session create and
 * guild voice join, and reads it on conversation create and on `mls/enable` to record which device
 * built the group; elsewhere it is ignored. Sending it everywhere is simpler than maintaining a
 * path list, costs nothing, and is why `mls/enable` needed no change when the server started
 * reading it - a path list would have.
 *
 * Placed *after* `tokenInterceptor` in the chain so the self-hosted base-URL rewrite has already
 * happened by the time the `baseUrl()` guard runs.
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

                    // One retry, no recursion: `next(...)` here is not routed back through this
                    // interceptor, so a device id the server keeps rejecting fails on the second
                    // attempt instead of looping.
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

/**
 * Matches the body, not just the status: a bare 400 covers everything from a malformed call id
 * to an already-ended call, and retrying those would be wrong.
 */
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
