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
import {TranslateModule} from '@ngx-translate/core';
import {EmailVerificationService} from '../../services/email-verification.service';
import {MfaChallengeService, mfaErrorKind} from '../../services/mfa-challenge.service';
import {PasswordResetDialogService} from '../password-reset/password-reset.service';
import {ExternalLinkService} from "../../services/external-link.service";
import {ApiConfigService, ServerConfiguration} from "../../services/api-config.service";
import {environment} from "../../../environments/environment";
import {QrLoginPanelComponent} from "./qr-login-panel/qr-login-panel.component";

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
        QrLoginPanelComponent
    ],
    templateUrl: './login.component.html',
    styleUrl: './login.component.css',
})
export class Login {
    protected mode = signal<AuthMode>('login');
    protected externalLinkService = inject(ExternalLinkService);
    protected authService = inject(AuthService);
    protected router = inject(Router);

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
    private destroyRef = inject(DestroyRef);

    constructor() {
        this.authService.isLoggedIn().then(r => {
            if (r) this.router.navigate(['/overview']);
        });

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

    protected openPasswordReset(): void {
        const value = this.loginModel().username;
        // The reset endpoints go through ApiConfigService.baseUrl(), which only points at a
        // self-hosted server once applyLoginInput() has parsed a `user@server` identity —
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
                const status = err?.status ?? err?.reason?.status;
                if (status === 403) {
                    const {username, password} = this.loginModel();
                    this.emailVerification.show(username, 'none', {email: username, password});
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
        this.authService.register(model.email, model.username, model.password, this.parseBirthdate(model.birthdate)).pipe(
            tap(() => {
                const hint = domain !== 'venta.gg'
                    ? ` Sign in using ${model.username}@${domain}.`
                    : '';
                this.toast.success('Account created!', {detail: `Welcome to Alpine.${hint}`});
                this.switchToMode('login');
            }),
            catchError((err) => {
                this.toast.httpError('Registration failed', err, {detail: 'Please check your details and try again.'});
                return EMPTY;
            })
        ).subscribe();
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
