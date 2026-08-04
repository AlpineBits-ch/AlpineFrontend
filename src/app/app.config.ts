import {
    APP_INITIALIZER,
    ApplicationConfig,
    ErrorHandler,
    inject,
    provideAppInitializer,
    provideBrowserGlobalErrorListeners,
    provideZoneChangeDetection,
} from "@angular/core";
import {provideRouter, Router, withHashLocation} from "@angular/router";
import {provideAnimations} from "@angular/platform-browser/animations";
import {AuthConfig, OAuthStorage, provideOAuthClient} from 'angular-oauth2-oidc';
import {routes} from "./app.routes";
import {providePrimeNG} from "primeng/config";
import {MessageService} from 'primeng/api';
import {provideHttpClient, withInterceptors} from "@angular/common/http";
import {tokenInterceptor} from "./interceptors/token-interceptor";
import {deviceIdInterceptor} from "./interceptors/device-id-interceptor";
import {timeoutInterceptor} from "./interceptors/timeout.interceptor";
import {rateLimitInterceptor} from "./interceptors/rate-limit-interceptor";
import {GlobalErrorHandler} from "./core/global-error-handler";
import {ThemeService} from './services/theme.service';
import {LanguageService} from './services/language.service';
import {DEFAULT_LANGUAGE, storedLanguage} from './models/language.model';
import {provideTranslateService} from '@ngx-translate/core';
import {provideTranslateHttpLoader} from '@ngx-translate/http-loader';
import {AlpinePreset} from './theme/alpine-preset';
import * as Sentry from "@sentry/angular";
import {ApiConfigService} from "./services/api-config.service";
import {authConfig} from './auth.config';
import {
    activeSlotId,
    migrateLegacyOAuthKeys,
    ScopedOAuthStorage,
} from './services/scoped-oauth-storage';


export function authConfigFactory(): AuthConfig {
    const apiService = inject(ApiConfigService);
    const currentApiUrl = apiService.baseUrl();

    return {
        ...authConfig,
        tokenEndpoint: `${currentApiUrl}/connect/token`,
    };

}

/**
 * Tokens, namespaced by account slot.
 *
 * <p>This used to hand `angular-oauth2-oidc` raw `localStorage`, which writes to fixed key names -
 * so a second account's tokens overwrote the first's and signing in anywhere meant signing out
 * everywhere. See {@link ScopedOAuthStorage}.</p>
 *
 * <p>The migration runs here rather than in an initialiser because it has to happen before the
 * first token read, and the first token read happens while the injector is still being built. An
 * installation upgrading has unprefixed keys, and a build that only looks at prefixed ones finds
 * none - which presents as the update signing everybody out.</p>
 */
export function storageFactory(): OAuthStorage {
    migrateLegacyOAuthKeys(activeSlotId());
    return new ScopedOAuthStorage();
}


export const appConfig: ApplicationConfig = {
    providers: [
        // rateLimit is outermost so a backoff wait is not charged against the request timeout.
        provideHttpClient(withInterceptors([
            rateLimitInterceptor, tokenInterceptor, deviceIdInterceptor, timeoutInterceptor,
        ])),
        provideOAuthClient(),
        {provide: OAuthStorage, useFactory: storageFactory},
        {provide: ErrorHandler, useClass: GlobalErrorHandler},
        {
            provide: ErrorHandler,
            useValue: Sentry.createErrorHandler(),
        },
        {
            provide: Sentry.TraceService,
            deps: [Router],
        },
        {
            provide: APP_INITIALIZER,
            useFactory: () => () => {},
            deps: [Sentry.TraceService],
            multi: true,
        },
        provideBrowserGlobalErrorListeners(),
        provideTranslateService({
            // Resolved from storage here rather than in LanguageService, so the very first load
            // request is for the language the user picked - not English, swapped a tick later.
            lang: storedLanguage(),
            loader: provideTranslateHttpLoader({
                prefix: './assets/i18n/locales/',
                suffix: '.json',
            }),
            fallbackLang: DEFAULT_LANGUAGE
        }),
        provideZoneChangeDetection({eventCoalescing: true}),
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
        provideAnimations(),
        provideAppInitializer(() => {
            inject(ThemeService);
            inject(LanguageService);
        })

    ],
};
