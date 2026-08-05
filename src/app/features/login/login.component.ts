import {Component, computed, DestroyRef, inject, signal} from '@angular/core';
import {takeUntilDestroyed, toObservable} from '@angular/core/rxjs-interop';
import {InputText} from "primeng/inputtext";
import {PasswordDirective} from "primeng/password";
import {Button} from "primeng/button";
import {AuthService} from "../../services/auth.service";
import {catchError, debounceTime, distinctUntilChanged, EMPTY, of, switchMap, tap} from "rxjs";
import {email, form, FormField, pattern, required} from "@angular/forms/signals";
import {Router} from "@angular/router";
import {NgClass} from "@angular/common";
import {FormsModule} from "@angular/forms";
import {UserSettingsService} from "../../services/user-settings.service";
import {ToastService} from "../../services/toast.service";
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {EmailVerificationService} from '../../services/email-verification.service';
import {hasFieldError, RegistrationFieldErrors, registrationFieldErrors} from './registration-errors';
import {MfaChallengeService, mfaErrorKind} from '../../services/mfa-challenge.service';
import {PasswordResetDialogService} from '../password-reset/password-reset.service';
import {ExternalLinkService} from "../../services/external-link.service";
import {ApiConfigService, ServerConfiguration} from "../../services/api-config.service";
import {environment} from "../../../environments/environment";
import {QrLoginPanelComponent} from "./qr-login-panel/qr-login-panel.component";
import {AccountRegistryService, AccountSlot} from "../../services/account-registry.service";
import {AccountSwitchService} from "../../services/account-switch.service";
import {signInBlocked} from './sign-in-blocked';
import {BlockedSignInComponent} from './blocked-sign-in/blocked-sign-in.component';
import {SupportService} from '../../services/support.service';

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
        FormsModule,
        TranslateModule,
        QrLoginPanelComponent,
        BlockedSignInComponent
    ],
    templateUrl: './login.component.html',
    styleUrl: './login.component.css',
})
export class Login {
    /** Abandons the add and goes back to an account that is already signed in. */
    protected returnTo(slot: AccountSlot): void {
        void this.switcher.switchTo(slot.id);
    }

    protected mode = signal<AuthMode>('login');
    protected externalLinkService = inject(ExternalLinkService);
    protected authService = inject(AuthService);
    protected router = inject(Router);

    /**
     * Set when the server refused the sign-in because the account is restricted.
     *
     * <p>Replaces the whole auth card while it is set - see `blocked-sign-in.component.ts`. Nothing
     * about this state touches stored data: a restriction gets lifted, and an appeal that succeeds
     * should hand the account back a working client rather than an empty one.</p>
     */
    protected blocked = signal<ReturnType<typeof signInBlocked>>(null);

    /**
     * Which server refused. Captured at the moment of failure because the support site is derived
     * from it, and a `user@selfhosted.com` identity must not be sent to our support site.
     */
    protected blockedApiBase = signal<string>(environment.apiUrl);

    // ── Login form ────────────────────────────────────────────────────────────
    protected loginModel = signal<LoginModel>({username: '', password: ''});
    protected loginForm = form(this.loginModel, (_schema) => {});
    protected serverLabel = computed(() =>
        ApiConfigService.serverLabel(this.loginModel().username)
    );
    protected isCustomServer = computed(() =>
        this.loginModel().username.includes('@')
    );
    protected loginServerConfig = signal<ServerConfiguration | null>(null);
    protected loginServerConfigLoading = signal(false);
    protected loginServerConfigError = signal(false);
    protected loginEnabled = computed(() =>
        this.loginServerConfig()?.isLoginEnabled !== false
    );

    // ── Register form ─────────────────────────────────────────────────────────
    protected registerModel = signal<RegisterModel>({
        username: '',
        email: '',
        password: '',
        confirmPassword: '',
        birthdate: ''
    });
    protected passwordMismatch = signal(false);

    /**
     * What the server refused, per field.
     *
     * <p>Kept apart from `registerForm` because these are not properties of what the user typed -
     * a username is taken until it isn't, and re-running the client validators cannot decide it.
     * Cleared as soon as the field they belong to is edited.</p>
     */
    protected serverErrors = signal<RegistrationFieldErrors>({general: []});

    protected registerForm = form(this.registerModel, (schema) => {
        required(schema.birthdate, {message: 'Birthdate is required.'});
        required(schema.email, {message: 'Email is required.'});
        required(schema.password, {message: 'Password is required.'});
        required(schema.confirmPassword, {message: 'Confirm password is required.'});
        email(schema.email, {message: 'Please enter a valid email address.'});
        pattern(
            schema.birthdate,
            /^(0[1-9]|[12][0-9]|3[01])\.(0[1-9]|1[012])\.(19|20)\d\d$/,
            {message: 'Please enter a valid date in dd.mm.yyyy format.'}
        );
    });

    // ── Server selector ───────────────────────────────────────────────────────
    // Shared by register and QR. The sign-in tab has its own, derived from the
    // `user@server` form of the username field, because there the server is part of
    // the identity being typed rather than a separate choice.
    protected serverDomain = signal('venta.gg');
    protected isEditingServer = signal(false);
    protected serverInputValue = 'venta.gg';
    protected serverConfig = signal<ServerConfiguration | null>(null);
    protected serverConfigLoading = signal(false);
    protected serverConfigError = signal(false);
    protected serverUrl = computed(() => ApiConfigService.domainToUrl(this.serverDomain()));
    protected registerEnabled = computed(() =>
        this.serverConfig()?.isRegisterEnabled !== false
    );

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

    /**
     * Accounts already signed in on this machine, offered as a way back.
     *
     * <p>Reaching this screen through "Add Account" sets the live account aside without signing it
     * out. Without this the only route back to a session that is still perfectly valid is to type
     * its password again - and there is no other affordance on this screen that could serve.</p>
     *
     * <p>Empty on a normal sign-out, which removes the slot, so this stays invisible for everyone
     * who is not mid-add.</p>
     */
    protected returnableAccounts = signal<AccountSlot[]>([]);

    constructor() {
        this.authService.isLoggedIn().then(r => {
            if (r) this.router.navigate(['/overview']);
        });

        void this.accounts.list().then(slots => this.returnableAccounts.set(slots));

        // Watch the server derived from the login username and fetch config
        const loginServerUrl = computed(() => {
            const u = this.loginModel().username;
            const atIdx = u.lastIndexOf('@');
            return atIdx > 0 ? `https://${u.slice(atIdx + 1)}` : environment.apiUrl;
        });

        toObservable(loginServerUrl).pipe(
            debounceTime(500),
            distinctUntilChanged(),
            switchMap(url => {
                this.loginServerConfigLoading.set(true);
                this.loginServerConfigError.set(false);
                return this.apiConfigService.getServerConfiguration(url).pipe(
                    catchError(() => {
                        this.loginServerConfigError.set(true);
                        return of(null);
                    })
                );
            }),
            takeUntilDestroyed(this.destroyRef)
        ).subscribe(config => {
            this.loginServerConfig.set(config);
            this.loginServerConfigLoading.set(false);
        });

        // Fetch server config on init (default server)
        this.fetchServerConfig(environment.apiUrl);
    }

    protected switchToMode(mode: AuthMode): void {
        // QR pairing is minted by whichever server ApiConfigService currently points at, and
        // the token exchange rides the OAuth config alongside it. Applying the selection on
        // the way in keeps both pointing at the server shown next to the code.
        if (mode === 'qr') this.apiConfigService.setServer(this.serverDomain());
        this.mode.set(mode);
    }

    /** A QR pairing that reached `approved` has already stored its tokens. */
    protected onQrAuthenticated(): void {
        this.userSettings.load();
        void this.router.navigate(['/overview']);
    }

    /**
     * Leaves the blocked screen for a cleared sign-in form.
     *
     * <p>The password goes with it: the next person at this keyboard is by assumption someone
     * else, and leaving a restricted account's credentials in the fields invites another attempt
     * at the one thing that cannot work.</p>
     */
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
        // The reset endpoints go through ApiConfigService.baseUrl(), which only points at a
        // self-hosted server once applyLoginInput() has parsed a `user@server` identity -
        // normally during a login attempt. Someone resetting their password on a fresh
        // install has never logged in, so without this the request would go to the default
        // server and silently do nothing. `user@host` is read as server-qualified here for
        // the same reason login reads it that way.
        if (this.isCustomServer()) this.apiConfigService.applyLoginInput(value);
        this.passwordResetDialog.show(this.looksLikeEmail(value) ? value : '');
    }

    protected login(): void {
        this.authService.login(
            this.loginModel().username,
            this.loginModel().password
        ).pipe(
            tap(() => {
                this.userSettings.load();
                void this.router.navigate(['/overview']);
            }),
            catchError((err) => {
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
                this.toast.httpError('Sign in failed', err, {detail: 'Invalid username or password.'});
                return EMPTY;
            })
        ).subscribe();
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

        // Apply the selected server before the API call
        const domain = this.serverDomain();
        this.apiConfigService.setServer(domain);

        this.passwordMismatch.set(false);
        this.serverErrors.set({general: []});
        this.authService.register(model.email, model.username, model.password, this.parseBirthdate(model.birthdate)).pipe(
            tap(() => {
                // A 202, and nothing more: the address may have been free, or it may already have an
                // account, and the response is identical either way by design. So no "account
                // created" - what is true for every outcome is that mail is on the way if that
                // address could be registered, and the next step is the code from it.
                const handle = domain !== 'venta.gg' ? `${model.username}@${domain}` : model.username;
                // Ready on the sign-in tab behind the dialog, for the user whose auto-sign-in does
                // not happen: on a self-hosted server the bare username would reach the wrong one.
                this.loginModel.update(m => ({...m, username: handle}));
                this.emailVerification.show(model.email, {
                    certainty: 'unknown',
                    credentials: {loginId: handle, password: model.password}
                });
                this.switchToMode('login');
            }),
            catchError((err) => this.onRegisterRefused(err))
        ).subscribe();
    }

    /**
     * Puts a registration `400` back on the form.
     *
     * <p>A `400` no longer says anything about the email address being taken - that answer is now a
     * `202` like any other. What it does say is that the username, the address or the birth date was
     * unacceptable, and the username case is the one the user cannot get past without being told.</p>
     */
    private onRegisterRefused(err: unknown) {
        const errors = registrationFieldErrors(err);
        this.serverErrors.set(errors);
        if (!hasFieldError(errors)) {
            this.toast.error(this.translate.instant('LOGIN.REGISTER.FAILED'), {
                detail: errors.general[0] ?? this.translate.instant('LOGIN.REGISTER.FAILED_DETAIL')
            });
        }
        return EMPTY;
    }

    /** Drops the server's verdict on a field as soon as its value changes. */
    protected clearServerError(field: 'username' | 'email' | 'birthdate'): void {
        if (!this.serverErrors()[field]) return;
        this.serverErrors.update(errors => ({...errors, [field]: undefined}));
    }

    protected startEditServer(): void {
        this.serverInputValue = this.serverDomain();
        this.isEditingServer.set(true);
    }

    protected confirmServer(): void {
        const raw = this.serverInputValue.trim();
        if (!raw) return;
        // Strip any protocol prefix and trailing slash
        const domain = raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
        this.serverDomain.set(domain);
        this.isEditingServer.set(false);
        // In QR mode the pairing is already bound to the old server, so re-point
        // ApiConfigService now; the panel restarts off the changed `serverUrl`.
        if (this.mode() === 'qr') this.apiConfigService.setServer(domain);
        this.fetchServerConfig(ApiConfigService.domainToUrl(domain));
    }

    protected cancelServerEdit(): void {
        this.isEditingServer.set(false);
        this.serverInputValue = this.serverDomain();
    }

    private fetchServerConfig(url: string): void {
        this.serverConfigLoading.set(true);
        this.serverConfigError.set(false);
        this.apiConfigService.getServerConfiguration(url).pipe(
            catchError(() => {
                this.serverConfigError.set(true);
                return of(null);
            })
        ).subscribe(config => {
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
