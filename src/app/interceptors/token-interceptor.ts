import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from "@angular/core";
import { OAuthService } from "angular-oauth2-oidc";
import { Router } from "@angular/router";
import { catchError, from, switchMap, throwError } from "rxjs";

let isRefreshing = false;

export const tokenInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.url.includes('connect/token')) return next(req);
  if (!req.url.startsWith('https://api.alpinebits.ch')) return next(req);

  const oAuthService = inject(OAuthService);
  const router = inject(Router);
  const accessCode = oAuthService.getAccessToken();

  if (accessCode) {
    req = req.clone({ setHeaders: { Authorization: `Bearer ${accessCode}` } });
  }

  return next(req).pipe(
    catchError((err) => {
      if (!(err instanceof HttpErrorResponse) || err.status !== 401) {
        return throwError(() => err);
      }

      // A refresh is already in flight — don't loop, just soft-logout
      if (isRefreshing) {
        softLogout(oAuthService, router);
        return throwError(() => err);
      }

      isRefreshing = true;
      return from(oAuthService.refreshToken()).pipe(
        switchMap(() => {
          isRefreshing = false;
          const newToken = oAuthService.getAccessToken();
          const retried = req.clone({ setHeaders: { Authorization: `Bearer ${newToken}` } });
          return next(retried).pipe(
            catchError((retryErr) => {
              if (retryErr instanceof HttpErrorResponse && retryErr.status === 401) {
                // Still 401 after a fresh token — session is dead
                softLogout(oAuthService, router);
              }
              return throwError(() => retryErr);
            }),
          );
        }),
        catchError((refreshErr) => {
          isRefreshing = false;
          softLogout(oAuthService, router);
          return throwError(() => refreshErr);
        }),
      );
    }),
  );
};

function softLogout(oAuthService: OAuthService, router: Router): void {
  oAuthService.logOut();
  void router.navigate(['/authentication']);
}
