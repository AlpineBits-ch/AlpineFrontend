import {
  ApplicationConfig,
  ErrorHandler,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from "@angular/core";
import { provideRouter } from "@angular/router";
import { provideAnimations } from "@angular/platform-browser/animations";
import {AuthConfig, OAuthStorage, provideOAuthClient} from 'angular-oauth2-oidc';
import { routes } from "./app.routes";
import {providePrimeNG} from "primeng/config";
import { MessageService } from 'primeng/api';
import {AlpinePreset} from './theme/alpine-preset';
import {HTTP_INTERCEPTORS, provideHttpClient, withInterceptors} from "@angular/common/http";
import {environment} from "../environments/environment";
import {tokenInterceptor} from "./interceptors/token-interceptor";
import {timeoutInterceptor} from "./interceptors/timeout.interceptor";
import {GlobalErrorHandler} from "./core/global-error-handler";

export const authConfig: AuthConfig = {
  issuer: 'http://identity:8080/', // Your OpenIddict server
  tokenEndpoint: `${environment.apiUrl}/connect/token`,
  clientId: 'echo',
  scope: 'openid offline_access',
  dummyClientSecret: '',
  oidc: false,
  disablePKCE: true,
  useSilentRefresh: true,
};

export function storageFactory(): OAuthStorage {
  return localStorage;
}
export const appConfig: ApplicationConfig = {
  providers: [
      provideHttpClient(withInterceptors([tokenInterceptor, timeoutInterceptor])),
    provideOAuthClient(),
    {provide: OAuthStorage, useFactory: storageFactory},
    {provide: ErrorHandler, useClass: GlobalErrorHandler},
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideAnimations(),
      providePrimeNG({
        theme: {
          preset: AlpinePreset,
          options: {
            darkModeSelector: '.dark',
          }
        }
      }),
      MessageService,
  ],
};
