import { HttpInterceptorFn } from '@angular/common/http';
import {inject} from "@angular/core";
import {OAuthService} from "angular-oauth2-oidc";

export const tokenInterceptor: HttpInterceptorFn = (req, next) => {
  if(req.url.includes('connect/token')) return next(req);
  if(!req.url.startsWith('https://api.alpinebits.ch')) return next(req);
  const oAuthService = inject(OAuthService);
  const accessCode = oAuthService.getAccessToken();
  if (!accessCode) {
    return next(req);
  }
  req = req.clone({
    setHeaders: {
      Authorization: `Bearer ${accessCode}`
    }
  });
  return next(req);
};
