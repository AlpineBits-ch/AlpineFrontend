import {HttpErrorResponse, HttpInterceptorFn} from '@angular/common/http';
import {inject} from "@angular/core";
import {OAuthService} from "angular-oauth2-oidc";
import {Router} from "@angular/router";
import {catchError, from, switchMap, throwError} from "rxjs";
import {environment} from "../../environments/environment";
import {ApiConfigService} from "../services/api-config.service";
import {isAnonymousStatusUrl} from "../services/status-api.service";

// Shared across all interceptor invocations. When a refresh is in-flight every
// concurrent 401 waits on the same Promise instead of triggering its own
// softLogout() -the previous source of the "app freeze" when tokens expired.
let isRefreshing = false;
let refreshPromise: Promise<string> | null = null;

/** Reset module-level state between test runs. */
export function _resetInterceptorState(): void {
    isRefreshing = false;
    refreshPromise = null;
}

export const tokenInterceptor: HttpInterceptorFn = (req, next) => {
    const apiConfig = inject(ApiConfigService);
    const currentBase = apiConfig.baseUrl();

    // Rewrite base URL for self-hosted instances
    let request = req;
    if (req.url.startsWith(environment.apiUrl) && currentBase !== environment.apiUrl) {
        request = req.clone({url: currentBase + req.url.slice(environment.apiUrl.length)});
    }

    if (request.url.includes('connect/token')) return next(request);
    if (!request.url.startsWith(currentBase)) return next(request);
    // Platform status is anonymous on purpose: it has to answer when sign-in itself is what is
    // broken, and a bearer token attached to it can only turn a working call into a 401.
    if (isAnonymousStatusUrl(request.url)) return next(request);

    const oAuthService = inject(OAuthService);
    const router = inject(Router);
    const accessCode = oAuthService.getAccessToken();

    if (accessCode) {
        request = request.clone({setHeaders: {Authorization: `Bearer ${accessCode}`}});
    }

    return next(request).pipe(
        catchError((err) => {
            if (!(err instanceof HttpErrorResponse) || err.status !== 401) {
                return throwError(() => err);
            }

            // A 401 with no refresh token to spend cannot be recovered, so do not ask.
            // angular-oauth2-oidc does not check first: it posts `refresh_token=null` as a literal
            // string and lets the server reject it. After logout that POST goes to the DEFAULT
            // host, because ApiConfigService.reset() has just cleared the chosen server, so a
            // signed-out self-hosted client sits there posting nulls at api.venta.gg. Observed
            // doing exactly that.
            //
            // Ends the session rather than merely rethrowing. The outcome is the same one the
            // round trip would have produced - a rejected refresh, then softLogout - so skipping
            // the request must not also skip the consequence, or a 401 with no token would leave
            // the app half signed in with no route back to the login screen.
            if (!oAuthService.getRefreshToken()) {
                softLogout(oAuthService, router);
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

            // All concurrent 401s -including the one that started the refresh -
            // wait on the same Promise and retry with the new token once it resolves.
            return from(refreshPromise!).pipe(
                switchMap(newToken => {
                    const retried = request.clone({setHeaders: {Authorization: `Bearer ${newToken}`}});
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
