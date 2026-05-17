import {HttpErrorResponse, HttpInterceptorFn} from '@angular/common/http';
import {catchError, throwError, timeout, TimeoutError} from 'rxjs';

const REQUEST_TIMEOUT_MS = 30_000;

export const timeoutInterceptor: HttpInterceptorFn = (req, next) => {
    return next(req).pipe(
        timeout(REQUEST_TIMEOUT_MS),
        catchError(err => {
            if (err instanceof TimeoutError) {
                return throwError(() => new HttpErrorResponse({
                    status: 0,
                    statusText: 'Request timed out',
                    url: req.url,
                }));
            }
            return throwError(() => err);
        }),
    );
};
