import {HttpErrorResponse, HttpInterceptorFn} from '@angular/common/http';
import {inject} from '@angular/core';
import {OAuthService} from 'angular-oauth2-oidc';
import {Router} from '@angular/router';
import {catchError, from, switchMap, throwError} from 'rxjs';
import {environment} from '../../environments/environment';
import {ApiConfigService} from '../services/api-config.service';
import {AuthService, refreshWasRefused} from '../services/auth.service';
import {isAnonymousStatusUrl} from '../services/status-api.service';

// Refresh flights that already ended the session, so concurrent 401s sharing one log out once.
const endedBy = new WeakSet<Promise<string>>();

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
    // Platform status is anonymous: it has to answer when sign-in itself is what is broken.
    if (isAnonymousStatusUrl(request.url)) return next(request);

    const oAuthService = inject(OAuthService);
    const authService = inject(AuthService);
    const router = inject(Router);
    const accessCode = oAuthService.getAccessToken();

    if (accessCode) {
        request = request.clone({setHeaders: {Authorization: `Bearer ${accessCode}`}});
    }

    return next(request).pipe(
        catchError(err => {
            if (!(err instanceof HttpErrorResponse) || err.status !== 401) {
                return throwError(() => err);
            }

            // A 401 with no refresh token cannot be recovered, and angular-oauth2-oidc would post
            // `refresh_token=null` rather than check. Ends the session rather than merely
            // rethrowing, or the app is left half signed in with no route to the login screen.
            if (!oAuthService.getRefreshToken()) {
                softLogout(oAuthService, router);
                return throwError(() => err);
            }

            // Shared with the sockets and the token_expires handler: a second flight would spend
            // the same single-use refresh token.
            const flight = authService.refresh();

            return from(flight).pipe(
                catchError(refreshErr => {
                    if (refreshWasRefused(refreshErr) && !endedBy.has(flight)) {
                        endedBy.add(flight);
                        softLogout(oAuthService, router);
                    }
                    return throwError(() => err);
                }),
                switchMap(newToken => {
                    const retried = request.clone({setHeaders: {Authorization: `Bearer ${newToken}`}});
                    return next(retried).pipe(
                        catchError(retryErr => {
                            if (retryErr instanceof HttpErrorResponse && retryErr.status === 401) {
                                softLogout(oAuthService, router);
                            }
                            return throwError(() => retryErr);
                        }),
                    );
                }),
            );
        }),
    );
};

function softLogout(oAuthService: OAuthService, router: Router): void {
    oAuthService.logOut();
    void router.navigate(['/authentication']);
}
