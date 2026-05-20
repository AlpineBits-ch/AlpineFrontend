import {HttpErrorResponse, HttpInterceptorFn} from '@angular/common/http';
import {inject} from "@angular/core";
import {OAuthService} from "angular-oauth2-oidc";
import {Router} from "@angular/router";
import {catchError, from, switchMap, throwError} from "rxjs";
import {environment} from "../../environments/environment";

// Shared across all interceptor invocations. When a refresh is in-flight every
// concurrent 401 waits on the same Promise instead of triggering its own
// softLogout() — the previous source of the "app freeze" when tokens expired.
let isRefreshing = false;
let refreshPromise: Promise<string> | null = null;

/** Reset module-level state between test runs. */
export function _resetInterceptorState(): void {
    isRefreshing = false;
    refreshPromise = null;
}

export const tokenInterceptor: HttpInterceptorFn = (req, next) => {
    if (req.url.includes('connect/token')) return next(req);
    if (!req.url.startsWith(environment.apiUrl)) return next(req);

    const oAuthService = inject(OAuthService);
    const router = inject(Router);
    const accessCode = oAuthService.getAccessToken();

    if (accessCode) {
        req = req.clone({setHeaders: {Authorization: `Bearer ${accessCode}`}});
    }

    return next(req).pipe(
        catchError((err) => {
            if (!(err instanceof HttpErrorResponse) || err.status !== 401) {
                return throwError(() => err);
            }

            if (!isRefreshing) {
                isRefreshing = true;
                refreshPromise = oAuthService.refreshToken()
                    .then(() => {
                        isRefreshing = false;
                        refreshPromise = null;
                        return oAuthService.getAccessToken() as string;
                    })
                    .catch((refreshErr: unknown) => {
                        isRefreshing = false;
                        refreshPromise = null;
                        softLogout(oAuthService, router);
                        throw refreshErr;
                    });
            }

            // All concurrent 401s — including the one that started the refresh —
            // wait on the same Promise and retry with the new token once it resolves.
            return from(refreshPromise!).pipe(
                switchMap(newToken => {
                    const retried = req.clone({setHeaders: {Authorization: `Bearer ${newToken}`}});
                    return next(retried).pipe(
                        catchError((retryErr) => {
                            if (retryErr instanceof HttpErrorResponse && retryErr.status === 401) {
                                softLogout(oAuthService, router);
                            }
                            return throwError(() => retryErr);
                        }),
                    );
                }),
                catchError(() => throwError(() => err)),
            );
        }),
    );
};

function softLogout(oAuthService: OAuthService, router: Router): void {
    oAuthService.logOut();
    void router.navigate(['/authentication']);
}
