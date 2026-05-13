import {
  ApplicationConfig,
  ErrorHandler,
  inject,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
  APP_INITIALIZER, provideAppInitializer,
} from "@angular/core";
import { provideRouter } from "@angular/router";
import { provideAnimations } from "@angular/platform-browser/animations";
import { provideIonicAngular } from '@ionic/angular/standalone';
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
import { ThemeService } from './services/theme.service';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import {provideTranslateHttpLoader, TranslateHttpLoader} from '@ngx-translate/http-loader';
import { HttpClient } from '@angular/common/http';

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
    provideTranslateService({
      defaultLanguage: 'en',
      loader: provideTranslateHttpLoader({
        prefix: './assets/i18n/locales/',
        suffix: '.json',
      }),
      fallbackLang: 'en'
    }),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
      providePrimeNG({
        theme: {
          preset: AlpinePreset,
          options: {
            darkModeSelector: '.dark',
          }
        }
      }),
      MessageService,
    provideIonicAngular(),
    provideAppInitializer(() => { inject(ThemeService); })

  ],
};
