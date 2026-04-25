import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from "@angular/core";
import { provideRouter } from "@angular/router";
import {AuthConfig, OAuthStorage, provideOAuthClient} from 'angular-oauth2-oidc';
import { routes } from "./app.routes";
import {providePrimeNG} from "primeng/config";
import Aura from '@primeuix/themes/aura';
import {HTTP_INTERCEPTORS, provideHttpClient, withInterceptors} from "@angular/common/http";
import {environment} from "../environments/environment";
import {tokenInterceptor} from "./interceptors/token-interceptor";

export const authConfig: AuthConfig = {
  issuer: 'http://identity:8080/', // Your OpenIddict server
  tokenEndpoint: `${environment.apiUrl}/connect/token`,
  clientId: 'echo',
  scope: 'openid offline_access',
  dummyClientSecret: '',
  oidc: false,
  disablePKCE: true,
  useSilentRefresh: false,
};

export function storageFactory(): OAuthStorage {
  return localStorage;
}
export const appConfig: ApplicationConfig = {
  providers: [
      provideHttpClient(withInterceptors([tokenInterceptor])),
    provideOAuthClient(),
    {provide: OAuthStorage, useFactory: storageFactory},
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
      providePrimeNG({
        theme: {
          preset: Aura
        }
      })
  ],
};
