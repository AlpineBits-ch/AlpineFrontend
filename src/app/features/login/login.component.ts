import {ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {InputText} from 'primeng/inputtext';
import {PasswordDirective} from 'primeng/password';
import {Button} from 'primeng/button';
import {AuthService} from '../../services/auth.service';
import {catchError, EMPTY, of, tap} from 'rxjs';
import {email, form, FormField, pattern, required} from '@angular/forms/signals';
import {Router} from '@angular/router';
import {NgClass} from '@angular/common';

import {UserSettingsService} from '../../services/user-settings.service';
import {ToastService} from '../../services/toast.service';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {EmailVerificationService} from '../../services/email-verification.service';
import {hasFieldError, RegistrationFieldErrors, registrationFieldErrors} from './registration-errors';
import {MfaChallengeService, mfaErrorKind} from '../../services/mfa-challenge.service';
import {PasswordResetDialogService} from '../password-reset/password-reset.service';
import {ExternalLinkService} from '../../services/external-link.service';
import {ApiConfigService, ServerConfiguration} from '../../services/api-config.service';
import {environment} from '../../../environments/environment';
import {QrLoginPanelComponent} from './qr-login-panel/qr-login-panel.component';
import {InstancePickerComponent} from './instance-picker/instance-picker.component';
import {AccountRegistryService, AccountSlot} from '../../services/account-registry.service';
import {AccountSwitchService} from '../../services/account-switch.service';
import {signInBlocked} from './sign-in-blocked';
import {BlockedSignInComponent} from './blocked-sign-in/blocked-sign-in.component';
import {SupportService} from '../../services/support.service';
import {PlatformCapabilities} from '../../platform/capabilities';
import {describeProbeFailure, retryTransient} from './server-config-probe';

/** `qr` is a peer of `login`, not a sub-step of it: it produces its own token pair. */
type AuthMode = 'login' | 'register' | 'qr';

interface LoginModel {
    username: string;
    password: string;
}

interface RegisterModel {
    email: string;
    password: string;
    confirmPassword: string;
    birthdate: string;
    username: string;
}

@Component({
    selector: 'app-login',
    imports: [
        InputText,
        PasswordDirective,
        Button,
        FormField,
        NgClass,
        TranslateModule,
        QrLoginPanelComponent,
        BlockedSignInComponent,
        InstancePickerComponent,
    ],
    templateUrl: './login.component.html',
    styleUrl: './login.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Login {
    /** Abandons the add and goes back to an account that is already signed in. */
    protected returnTo(slot: AccountSlot): void {
        void this.switcher.switchTo(slot.id);
    }

    protected readonly mode = signal<AuthMode>('login');
    /** A web build is served by one instance, so it never offers a choice of them. */
    protected readonly capabilities = inject(PlatformCapabilities);
    protected externalLinkService = inject(ExternalLinkService);
    protected authService = inject(AuthService);
    protected router = inject(Router);

    /** Set when the server refused the sign-in because the account is restricted. */
    protected readonly blocked = signal<ReturnType<typeof signInBlocked>>(null);

    /**
     * Which server refused. Captured at the moment of failure because the support site is derived
     * from it, and a `user@selfhosted.com` identity must not be sent to our support site.
     */
    protected readonly blockedApiBase = signal<string>(environment.apiUrl);

    // ── Login form ────────────────────────────────────────────────────────────
    protected readonly loginModel = signal<LoginModel>({username: '', password: ''});
    protected loginForm = form(this.loginModel, _schema => {});

    /**
     * An instance the identity points at that is not the selected one, offered after a refusal.
     *
     * <p>The only place the client reads a `@` as a host, and it never acts on its own.</p>
     */
    protected readonly suggestedInstance = signal<string | null>(null);
    private readonly suggestionTried = signal(false);

    // ── Register form ─────────────────────────────────────────────────────────
    protected readonly registerModel = signal<RegisterModel>({
        username: '',
        email: '',
        password: '',
        confirmPassword: '',
        birthdate: '',
    });
    protected readonly passwordMismatch = signal(false);

    /** What the server refused, per field. */
    protected readonly serverErrors = signal<RegistrationFieldErrors>({general: []});

    protected registerForm = form(this.registerModel, schema => {
        required(schema.birthdate, {message: 'Birthdate is required.'});
        required(schema.email, {message: 'Email is required.'});
        required(schema.password, {message: 'Password is required.'});
        required(schema.confirmPassword, {message: 'Confirm password is required.'});
        email(schema.email, {message: 'Please enter a valid email address.'});
        pattern(schema.birthdate, /^(0[1-9]|[12][0-9]|3[01])\.(0[1-9]|1[012])\.(19|20)\d\d$/, {
            message: 'Please enter a valid date in dd.mm.yyyy format.',
        });
    });

    // ── Instance ──────────────────────────────────────────────────────────────
    // One selection for the whole card. Sign-in used to derive its own from the `user@server`
    // form of the username, which is what made an email address re-point the client at its
    // mail host.
    protected readonly serverDomain = signal(ApiConfigService.homeDomain);
    protected readonly serverConfig = signal<ServerConfiguration | null>(null);
    protected readonly serverConfigLoading = signal(false);
    protected readonly serverConfigError = signal(false);
    protected readonly serverUrl = computed(() => ApiConfigService.domainToUrl(this.serverDomain()));
    protected readonly registerEnabled = computed(() => this.serverConfig()?.isRegisterEnabled !== false);
    protected readonly loginEnabled = computed(() => this.serverConfig()?.isLoginEnabled !== false);

    protected readonly instanceState = computed<'idle' | 'loading' | 'error'>(() => {
        if (this.serverConfigLoading()) return 'loading';
        return this.serverConfigError() ? 'error' : 'idle';
    });

    private apiConfigService = inject(ApiConfigService);
    private userSettings = inject(UserSettingsService);
    private toast = inject(ToastService);
    private emailVerification = inject(EmailVerificationService);
    private mfaChallenge = inject(MfaChallengeService);
    private passwordResetDialog = inject(PasswordResetDialogService);
    private translate = inject(TranslateService);
    private destroyRef = inject(DestroyRef);
    private accounts = inject(AccountRegistryService);
    private switcher = inject(AccountSwitchService);
    private support = inject(SupportService);

    /** Accounts already signed in on this machine, offered as a way back. */
    protected readonly returnableAccounts = signal<AccountSlot[]>([]);

    /**
     * Instances this machine has signed in to, newest first.
     *
     * <p>Read off the account slots rather than a list of its own: a slot is per-server by
     * construction and already records when it was last used.</p>
     */
    protected readonly recentInstances = computed(() => {
        const newestFirst = [...this.returnableAccounts()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
        return [...new Set(newestFirst.map(slot => ApiConfigService.urlToDomain(slot.serverUrl)))];
    });

    constructor() {
        // No "am I already signed in, take me back" check here, and it must not come back:
        // {@link hasSession} answers that before any screen is matched, and a redirect here would
        // break "Add Account", which leaves the previous account signed in on purpose.

        void this.accounts.list().then(slots => this.returnableAccounts.set(slots));

        // The instance this install was last pointed at. During "Add Account" the slot-scoped key
        // misses on purpose and this falls back to the shared last-server-used.
        this.serverDomain.set(ApiConfigService.urlToDomain(this.apiConfigService.baseUrl()));
        this.fetchServerConfig(this.serverUrl());
    }

    /**
     * Applies a pick straight away rather than at submit.
     *
     * <p>QR mints its pairing against whatever `ApiConfigService` points at, and the password
     * reset request has nothing else to derive a host from, so both need it applied before they
     * are reached.</p>
     */
    protected onInstanceChange(domain: string): void {
        if (domain === this.serverDomain()) return;
        this.serverDomain.set(domain);
        this.clearSuggestion();
        this.apiConfigService.setServer(domain);
        this.fetchServerConfig(this.serverUrl());
    }

    protected switchToMode(mode: AuthMode): void {
        this.mode.set(mode);
    }

    /** A QR pairing that reached `approved` has already stored its tokens. */
    protected onQrAuthenticated(): void {
        this.userSettings.load();
        void this.router.navigate(['/overview']);
    }

    /** Leaves the blocked screen for a cleared sign-in form. */
    protected tryAnotherAccount(): void {
        this.blocked.set(null);
        this.loginModel.set({username: '', password: ''});
        this.mode.set('login');
    }

    /** The support site, reachable while signed out - which is the whole point of it. */
    protected openSupport(): void {
        this.support.openSupport(this.apiConfigService.baseUrl());
    }

    protected openPasswordReset(): void {
        const value = this.loginModel().username;
        this.passwordResetDialog.show(this.looksLikeEmail(value) ? value : '');
    }

    protected login(): void {
        this.authService
            .login(this.loginModel().username, this.loginModel().password)
            .pipe(
                tap(() => {
                    this.userSettings.load();
                    void this.router.navigate(['/overview']);
                }),
                catchError(err => {
                    if (mfaErrorKind(err) === 'required') {
                        const {username, password} = this.loginModel();
                        this.mfaChallenge.show(username, password);
                        return EMPTY;
                    }
                    // Checked before the generic 403 branch below, which reads every refusal as an
                    // unconfirmed email. A restricted account used to land in the "check your inbox
                    // for a code" dialog and type codes that could never work.
                    const restricted = signInBlocked(err);
                    if (restricted) {
                        this.blockedApiBase.set(this.apiConfigService.baseUrl());
                        this.blocked.set(restricted);
                        return EMPTY;
                    }
                    const status = err?.status ?? err?.reason?.status;
                    if (status === 403) {
                        const {username, password} = this.loginModel();
                        this.emailVerification.show(username, {credentials: {loginId: username, password}});
                        return EMPTY;
                    }
                    if (this.offerOtherInstance(err)) return EMPTY;
                    this.toast.httpError('Sign in failed', err, {detail: 'Invalid username or password.'});
                    return EMPTY;
                }),
            )
            .subscribe();
    }

    /**
     * Probes the instance the identity names, once, and offers it if it answers.
     *
     * <p>Returns whether the refusal has been taken over, so the caller knows to hold the generic
     * toast back until the probe has decided.</p>
     */
    private offerOtherInstance(err: unknown): boolean {
        const domain = this.otherInstanceIn(this.loginModel().username);
        if (!domain || this.suggestionTried()) return false;
        this.suggestionTried.set(true);

        this.apiConfigService
            .getServerConfiguration(ApiConfigService.domainToUrl(domain))
            .pipe(
                catchError(() => of(null)),
                takeUntilDestroyed(this.destroyRef),
            )
            .subscribe(config => {
                if (config) this.suggestedInstance.set(domain);
                else this.toast.httpError('Sign in failed', err, {detail: 'Invalid username or password.'});
            });

        return true;
    }

    /** The host half of a `user@host` identity, when it is not already the selected instance. */
    private otherInstanceIn(identity: string): string | null {
        const atIdx = identity.lastIndexOf('@');
        if (atIdx <= 0) return null;
        const domain = identity.slice(atIdx + 1);
        if (!domain.includes('.') || domain === this.serverDomain()) return null;
        return domain;
    }

    /** Switches to the offered instance and tries the same credentials once more. */
    protected takeSuggestion(): void {
        const domain = this.suggestedInstance();
        if (!domain) return;
        this.suggestedInstance.set(null);
        this.serverDomain.set(domain);
        this.apiConfigService.setServer(domain);
        this.fetchServerConfig(this.serverUrl());
        this.login();
    }

    /** A changed identity is a new attempt, so the instance may be worth offering again. */
    protected clearSuggestion(): void {
        this.suggestedInstance.set(null);
        this.suggestionTried.set(false);
    }

    protected register(): void {
        this.registerForm().markAsTouched();
        this.registerForm().markAsDirty();
        this.registerForm.birthdate().markAsTouched();
        this.registerForm.email().markAsTouched();
        this.registerForm.password().markAsTouched();
        this.registerForm.confirmPassword().markAsTouched();
        this.registerForm.username().markAsTouched();
        this.registerForm.birthdate().markAsDirty();
        this.registerForm.email().markAsDirty();
        this.registerForm.password().markAsDirty();
        this.registerForm.confirmPassword().markAsDirty();
        this.registerForm.username().markAsDirty();

        const model = this.registerModel();
        if (model.password !== model.confirmPassword) {
            this.passwordMismatch.set(true);
            return;
        }
        if (!this.registerForm().valid()) return;

        this.passwordMismatch.set(false);
        this.serverErrors.set({general: []});
        this.authService
            .register(model.email, model.username, model.password, this.parseBirthdate(model.birthdate))
            .pipe(
                tap(() => {
                    // A 202, and nothing more: the address may have been free, or it may already have an
                    // account, and the response is identical either way by design. So no "account
                    // created" - what is true for every outcome is that mail is on the way if that
                    // address could be registered, and the next step is the code from it.
                    // Ready on the sign-in tab behind the dialog, for the user whose auto-sign-in
                    // does not happen. The bare username is enough: the picker still points at the
                    // instance just registered against.
                    this.loginModel.update(m => ({...m, username: model.username}));
                    this.emailVerification.show(model.email, {
                        certainty: 'unknown',
                        credentials: {loginId: model.username, password: model.password},
                    });
                    this.switchToMode('login');
                }),
                catchError(err => this.onRegisterRefused(err)),
            )
            .subscribe();
    }

    /** Puts a registration `400` back on the form. */
    private onRegisterRefused(err: unknown) {
        const errors = registrationFieldErrors(err);
        this.serverErrors.set(errors);
        if (!hasFieldError(errors)) {
            this.toast.error(this.translate.instant('LOGIN.REGISTER.FAILED'), {
                detail: errors.general[0] ?? this.translate.instant('LOGIN.REGISTER.FAILED_DETAIL'),
            });
        }
        return EMPTY;
    }

    /** Drops the server's verdict on a field as soon as its value changes. */
    protected clearServerError(field: 'username' | 'email' | 'birthdate'): void {
        if (!this.serverErrors()[field]) return;
        this.serverErrors.update(errors => ({...errors, [field]: undefined}));
    }

    private fetchServerConfig(url: string): void {
        this.serverConfigLoading.set(true);
        this.serverConfigError.set(false);
        this.apiConfigService
            .getServerConfiguration(url)
            .pipe(
                retryTransient(),
                catchError((err: unknown) => {
                    console.warn(`[login] ${url} did not answer: ${describeProbeFailure(err)}`);
                    this.serverConfigError.set(true);
                    return of(null);
                }),
                takeUntilDestroyed(this.destroyRef),
            )
            .subscribe(config => {
                this.serverConfig.set(config);
                this.serverConfigLoading.set(false);
            });
    }

    private parseBirthdate(dateStr: string): Date {
        const [day, month, year] = dateStr.split('.').map(Number);
        return new Date(year, month - 1, day);
    }

    /**
     * Minimal check for whether a login-field value is an email address rather than a bare
     * username - `username or user@selfhosted.com` is a valid value for this field, but only
     * the email form is safe to prefill into the password-reset dialog's `?email=` request.
     */
    private looksLikeEmail(value: string): boolean {
        const atIdx = value.lastIndexOf('@');
        if (atIdx <= 0) return false;
        const dotIdx = value.indexOf('.', atIdx + 1);
        return dotIdx > atIdx + 1 && dotIdx < value.length - 1;
    }

    public openLink(link: string): void {
        this.externalLinkService.openExternalLink(link);
    }
}
