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
import {ExternalLinkService} from "../../services/external-link.service";
import {ApiConfigService, ServerConfiguration} from "../../services/api-config.service";
import {environment} from "../../../environments/environment";

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
        TranslateModule
    ],
    templateUrl: './login.component.html',
    styleUrl: './login.component.css',
})
export class Login {
    protected isLoginMode = signal(true);
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

    // Register server selector
    protected registerServerDomain = signal('venta.gg');
    protected isEditingRegisterServer = signal(false);
    protected registerServerInputValue = 'venta.gg';
    protected registerServerConfig = signal<ServerConfiguration | null>(null);
    protected registerServerConfigLoading = signal(false);
    protected registerServerConfigError = signal(false);
    protected registerEnabled = computed(() =>
        this.registerServerConfig()?.isRegisterEnabled !== false
    );

    private apiConfigService = inject(ApiConfigService);
    private userSettings = inject(UserSettingsService);
    private toast = inject(ToastService);
    private emailVerification = inject(EmailVerificationService);
    private mfaChallenge = inject(MfaChallengeService);
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

        // Fetch register server config on init (default server)
        this.fetchRegisterConfig(environment.apiUrl);
    }

    protected switchToMode(loginMode: boolean): void {
        this.isLoginMode.set(loginMode);
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
        const domain = this.registerServerDomain();
        this.apiConfigService.setServer(domain);

        this.passwordMismatch.set(false);
        this.authService.register(model.email, model.username, model.password, this.parseBirthdate(model.birthdate)).pipe(
            tap(() => {
                const hint = domain !== 'venta.gg'
                    ? ` Sign in using ${model.username}@${domain}.`
                    : '';
                this.toast.success('Account created!', {detail: `Welcome to Alpine.${hint}`});
                this.switchToMode(true);
            }),
            catchError((err) => {
                this.toast.httpError('Registration failed', err, {detail: 'Please check your details and try again.'});
                return EMPTY;
            })
        ).subscribe();
    }

    protected startEditRegisterServer(): void {
        this.registerServerInputValue = this.registerServerDomain();
        this.isEditingRegisterServer.set(true);
    }

    protected confirmRegisterServer(): void {
        const raw = this.registerServerInputValue.trim();
        if (!raw) return;
        // Strip any protocol prefix and trailing slash
        const domain = raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
        this.registerServerDomain.set(domain);
        this.isEditingRegisterServer.set(false);
        this.fetchRegisterConfig(ApiConfigService.domainToUrl(domain));
    }

    protected cancelRegisterServerEdit(): void {
        this.isEditingRegisterServer.set(false);
        this.registerServerInputValue = this.registerServerDomain();
    }

    private fetchRegisterConfig(url: string): void {
        this.registerServerConfigLoading.set(true);
        this.registerServerConfigError.set(false);
        this.apiConfigService.getServerConfiguration(url).pipe(
            catchError(() => {
                this.registerServerConfigError.set(true);
                return of(null);
            })
        ).subscribe(config => {
            this.registerServerConfig.set(config);
            this.registerServerConfigLoading.set(false);
        });
    }

    private parseBirthdate(dateStr: string): Date {
        const [day, month, year] = dateStr.split('.').map(Number);
        return new Date(year, month - 1, day);
    }

    public openLink(link: string): void {
        this.externalLinkService.openExternalLink(link);
    }
}
