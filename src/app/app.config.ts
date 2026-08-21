import {
    APP_INITIALIZER,
    ApplicationConfig,
    ErrorHandler,
    inject,
    LOCALE_ID,
    provideAppInitializer,
    provideBrowserGlobalErrorListeners,
    provideZoneChangeDetection,
} from '@angular/core';
import {registerLocaleData} from '@angular/common';
import localeDe from '@angular/common/locales/de';
import localeFr from '@angular/common/locales/fr';
import {provideRouter, Router} from '@angular/router';
import {provideAnimations} from '@angular/platform-browser/animations';
import {AuthConfig, OAuthStorage, provideOAuthClient} from 'angular-oauth2-oidc';
import {routes} from './app.routes';
import {providePrimeNG} from 'primeng/config';
import {MessageService} from 'primeng/api';
import {provideHttpClient, withInterceptors} from '@angular/common/http';
import {tokenInterceptor} from './interceptors/token-interceptor';
import {deviceIdInterceptor} from './interceptors/device-id-interceptor';
import {timeoutInterceptor} from './interceptors/timeout.interceptor';
import {rateLimitInterceptor} from './interceptors/rate-limit-interceptor';
import {serverClockInterceptor} from './interceptors/server-clock-interceptor';
import {statusProbeInterceptor} from './interceptors/status-probe-interceptor';
import {GlobalErrorHandler} from './core/global-error-handler';
import {ThemeService} from './services/theme.service';
import {LanguageService} from './services/language.service';
import {DEFAULT_LANGUAGE, storedLanguage} from './models/language.model';
import {providePlatform} from './platform/provide-platform';
import {provideTranslateService} from '@ngx-translate/core';
import {provideTranslateHttpLoader} from '@ngx-translate/http-loader';
import {AlpinePreset} from './theme/alpine-preset';
import {cspNonce} from './csp-nonce';
import * as Sentry from '@sentry/angular';
import {ApiConfigService} from './services/api-config.service';
import {authConfig} from './auth.config';
import {activeSlotId, migrateLegacyOAuthKeys, ScopedOAuthStorage} from './services/scoped-oauth-storage';
import {HttpPersonaApi, PersonaApi} from './services/persona-api.service';
import {HttpRoleplayApi, RoleplayApi} from './services/roleplay-api.service';
import {DraftApi, HttpDraftApi} from './services/draft-api.service';
import {HttpWikiPublicationApi, WikiPublicationApi} from './services/wiki-publication-api.service';
import {provideRealtimeListeners, REALTIME_LISTENER} from './services/realtime-listeners';

registerLocaleData(localeDe);
registerLocaleData(localeFr);

/** Codes the block above covers. `en` needs no registration: Angular ships it. */
const LOCALES_WITH_DATA = new Set(['en', 'de', 'fr']);

export function localeIdFactory(): string {
    const code = inject(LanguageService).current();
    return LOCALES_WITH_DATA.has(code) ? code : DEFAULT_LANGUAGE;
}

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
        provideHttpClient(
            withInterceptors([
                statusProbeInterceptor,
                rateLimitInterceptor,
                tokenInterceptor,
                deviceIdInterceptor,
                timeoutInterceptor,
                serverClockInterceptor,
            ]),
        ),
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
            fallbackLang: DEFAULT_LANGUAGE,
        }),
        // Resolved once per injector, so a mid-session switch only reaches pipes created after it.
        {provide: LOCALE_ID, useFactory: localeIdFactory},
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
                },
            },
        }),
        MessageService,
        {provide: PersonaApi, useClass: HttpPersonaApi},
        {provide: RoleplayApi, useClass: HttpRoleplayApi},
        {provide: DraftApi, useClass: HttpDraftApi},
        {provide: WikiPublicationApi, useClass: HttpWikiPublicationApi},
        provideAnimations(),
        provideRealtimeListeners(),
        provideAppInitializer(() => {
            inject(ThemeService);
            inject(LanguageService);
            // The one resolution of the token. See `realtime-listeners.ts` for what it buys.
            inject(REALTIME_LISTENER);
        }),
    ],
};
