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
import {serverClockInterceptor} from "./interceptors/server-clock-interceptor";
import {statusProbeInterceptor} from "./interceptors/status-probe-interceptor";
import {GlobalErrorHandler} from "./core/global-error-handler";
import {ThemeService} from './services/theme.service';
import {LanguageService} from './services/language.service';
import {DEFAULT_LANGUAGE, storedLanguage} from './models/language.model';
import {providePlatform} from './platform/provide-platform';
import {provideTranslateService} from '@ngx-translate/core';
import {provideTranslateHttpLoader} from '@ngx-translate/http-loader';
import {AlpinePreset} from './theme/alpine-preset';
import {cspNonce} from './csp-nonce';
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

/** Tokens, namespaced by account slot. The migration must run here: the first token read beats any initialiser. */
export function storageFactory(): OAuthStorage {
    migrateLegacyOAuthKeys(activeSlotId());
    return new ScopedOAuthStorage();
}


export const appConfig: ApplicationConfig = {
    providers: [
        // Must stay first: services resolved by later providers inject these ports.
        providePlatform(),
        // Interceptor order is load-bearing: statusProbe and rateLimit outermost, serverClock innermost.
        provideHttpClient(withInterceptors([
            statusProbeInterceptor, rateLimitInterceptor, tokenInterceptor, deviceIdInterceptor,
            timeoutInterceptor, serverClockInterceptor,
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
            // Resolved from storage here so the first load request is for the language the user picked.
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
            // Do not remove: without it the web image's `style-src` refuses every PrimeNG `<style>`.
            csp: {nonce: cspNonce()},
            // Back to PrimeNG 20's default: `self` clips overlays inside a `p-dialog`'s scroll box.
            overlayAppendTo: 'body',
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
