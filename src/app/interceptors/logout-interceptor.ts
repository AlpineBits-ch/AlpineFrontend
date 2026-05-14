import {HttpEvent, HttpEventType, HttpHandlerFn, HttpInterceptorFn, HttpRequest} from '@angular/common/http';
import {inject} from "@angular/core";
import {OAuthService} from "angular-oauth2-oidc";
import {Observable, tap} from "rxjs";
import {Router} from "@angular/router";

export function logoutInterceptor(
    req: HttpRequest<unknown>,
    next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> {
  return next(req).pipe(
      tap((event) => {
        if (event.type === HttpEventType.Response && event.status === 401) {
          inject(OAuthService).logOut();
          void inject(Router).navigate(['/authentication']);
        }
      }),
  );
}