/**
 * A refusal is the only moment the client reads a `@` as a host, and it never acts on it alone.
 * Before this, any `@` re-pointed the whole client at the mail host before the request was sent.
 */
import {TestBed} from '@angular/core/testing';
import {provideRouter} from '@angular/router';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {TranslateModule} from '@ngx-translate/core';
import {of, throwError} from 'rxjs';
import {Login} from './login.component';
import {ApiConfigService} from '../../services/api-config.service';
import {AuthService} from '../../services/auth.service';
import {AccountRegistryService} from '../../services/account-registry.service';
import {AccountSwitchService} from '../../services/account-switch.service';
import {UserSettingsService} from '../../services/user-settings.service';
import {ToastService} from '../../services/toast.service';
import {EmailVerificationService} from '../../services/email-verification.service';
import {MfaChallengeService} from '../../services/mfa-challenge.service';
import {PasswordResetDialogService} from '../password-reset/password-reset.service';
import {ExternalLinkService} from '../../services/external-link.service';
import {SupportService} from '../../services/support.service';

function setup(loginError: unknown) {
    const toast = {error: vi.fn(), httpError: vi.fn()};
    const setServer = vi.fn();

    TestBed.configureTestingModule({
        imports: [Login, TranslateModule.forRoot()],
        providers: [
            provideRouter([]),
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ToastService, useValue: toast},
            {
                provide: AuthService,
                useValue: {login: vi.fn(() => throwError(() => loginError))},
            },
            {
                provide: ApiConfigService,
                useValue: {
                    baseUrl: () => 'https://api.venta.gg',
                    setServer,
                    getServerConfiguration: vi.fn((url: string) =>
                        url.includes('rp.thornwood.net')
                            ? of({isLoginEnabled: true, isRegisterEnabled: true})
                            : throwError(() => new Error('unreachable')),
                    ),
                },
            },
            {provide: AccountRegistryService, useValue: {list: async () => []}},
            {provide: AccountSwitchService, useValue: {switchTo: vi.fn()}},
            {provide: UserSettingsService, useValue: {load: vi.fn()}},
            {provide: EmailVerificationService, useValue: {show: vi.fn()}},
            {provide: MfaChallengeService, useValue: {show: vi.fn()}},
            {provide: PasswordResetDialogService, useValue: {show: vi.fn()}},
            {provide: ExternalLinkService, useValue: {openExternalLink: vi.fn()}},
            {provide: SupportService, useValue: {openSupport: vi.fn()}},
        ],
    });

    const fixture = TestBed.createComponent(Login);
    const http = TestBed.inject(HttpTestingController);
    // The startup config fetch goes through the real HttpClient; the stub above only covers the
    // calls the component makes via ApiConfigService.
    http.match(() => true).forEach(req => req.flush({isLoginEnabled: true, isRegisterEnabled: true}));

    return {fixture, toast, setServer, component: inner(fixture)};
}

function inner(fixture: {componentInstance: Login}) {
    return fixture.componentInstance as unknown as {
        loginModel: {set: (v: {username: string; password: string}) => void};
        serverDomain: () => string;
        suggestedInstance: () => string | null;
        login: () => void;
        takeSuggestion: () => void;
        clearSuggestion: () => void;
    };
}

const badCredentials = {status: 400, error: {error: 'invalid_grant'}};

describe('the other-instance offer', () => {
    it('offers the instance the identity names when it answers', () => {
        const {component} = setup(badCredentials);
        component.loginModel.set({username: 'ada@rp.thornwood.net', password: 'hunter2'});

        component.login();

        expect(component.suggestedInstance()).toBe('rp.thornwood.net');
    });

    it('shows the ordinary error when the domain is not an instance', () => {
        const {component, toast} = setup(badCredentials);
        component.loginModel.set({username: 'ada@fastmail.com', password: 'hunter2'});

        component.login();

        expect(component.suggestedInstance()).toBeNull();
        expect(toast.httpError).toHaveBeenCalled();
    });

    it('says nothing about a bare username', () => {
        const {component, toast} = setup(badCredentials);
        component.loginModel.set({username: 'ada', password: 'hunter2'});

        component.login();

        expect(component.suggestedInstance()).toBeNull();
        expect(toast.httpError).toHaveBeenCalled();
    });

    it('does not offer the instance that is already selected', () => {
        const {component, toast} = setup(badCredentials);
        component.loginModel.set({username: 'ada@venta.gg', password: 'hunter2'});

        component.login();

        expect(component.suggestedInstance()).toBeNull();
        expect(toast.httpError).toHaveBeenCalled();
    });

    it('offers once, then lets the plain error stand', () => {
        const {component, toast} = setup(badCredentials);
        component.loginModel.set({username: 'ada@rp.thornwood.net', password: 'hunter2'});

        component.login();
        component.takeSuggestion();

        expect(component.serverDomain()).toBe('rp.thornwood.net');
        expect(toast.httpError).toHaveBeenCalledTimes(1);
    });

    it('applies the instance before retrying', () => {
        const {component, setServer} = setup(badCredentials);
        component.loginModel.set({username: 'ada@rp.thornwood.net', password: 'hunter2'});

        component.login();
        component.takeSuggestion();

        expect(setServer).toHaveBeenCalledWith('rp.thornwood.net');
    });

    it('is offered again once the identity changes', () => {
        const {component} = setup(badCredentials);
        component.loginModel.set({username: 'ada@rp.thornwood.net', password: 'hunter2'});
        component.login();

        component.clearSuggestion();
        component.login();

        expect(component.suggestedInstance()).toBe('rp.thornwood.net');
    });
});
