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
import {provideHttpClient} from "@angular/common/http";
import {environment} from "../environments/environment";

export const authConfig: AuthConfig = {
  issuer: 'http://identity:8080/', // Your OpenIddict server
  tokenEndpoint: `${environment.apiUrl}/connect/token`,
  clientId: 'echo_frontend',
  scope: 'openid offline_access', // Identical to your manual code
  dummyClientSecret: '',
  oidc: false,
  disablePKCE: true,
};

export function storageFactory(): OAuthStorage {
  return localStorage;
}
export const appConfig: ApplicationConfig = {
  providers: [
      provideHttpClient(),
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
