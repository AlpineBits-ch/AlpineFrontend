import {Component, inject, signal} from '@angular/core';
import {InputText} from "primeng/inputtext";
import {PasswordDirective} from "primeng/password";
import {Button} from "primeng/button";
import {AuthService} from "../../services/auth.service";
import {catchError, EMPTY, tap} from "rxjs";
import {email, form, FormField, pattern, required} from "@angular/forms/signals";
import {Router} from "@angular/router";
import {NgClass} from "@angular/common";
import {UserSettingsService} from "../../services/user-settings.service";
import {ToastService} from "../../services/toast.service";
import {TranslateModule} from '@ngx-translate/core';
import {EmailVerificationService} from '../../services/email-verification.service';
import {ExternalLinkService} from "../../services/external-link.service";


interface LoginModel {
    email: string;
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
    protected loginModel = signal<LoginModel>({email: '', password: ''});
    protected registerModel = signal<RegisterModel>({
        username: '',
        email: '',
        password: '',
        confirmPassword: '',
        birthdate: ''
    });
    protected passwordMismatch = signal(false);
    protected loginForm = form(this.loginModel, (schema) => {

    });
    protected registerForm = form(this.registerModel, (schema) => {
        required(schema.birthdate, {
            message: 'Birthdate is required.',
        })
        required(schema.email, {
            message: 'Email is required.',
        })
        required(schema.password, {
            message: 'Password is required.',
        })
        required(schema.confirmPassword, {
            message: 'Confirm password is required.',
        })

        email(schema.email, {
            message: 'Please enter a valid email address.',
        })

        pattern(
            schema.birthdate,
            /^(0[1-9]|[12][0-9]|3[01])\.(0[1-9]|1[012])\.(19|20)\d\d$/,
            { message: 'Please enter a valid date in dd.mm.yyyy format.' }
        );
    });
    private userSettings = inject(UserSettingsService);
    private toast = inject(ToastService);
    private emailVerification = inject(EmailVerificationService);

    constructor() {
        this.authService.isLoggedIn().then(r => {
            if (r) {
                this.router.navigate(['/overview']);
            }
        });
    }

    protected switchToMode(loginMode: boolean): void {
        this.isLoginMode.set(loginMode);
    }

    protected login(): void {
        this.authService.login(
            this.loginModel().email,
            this.loginModel().password
        ).pipe(
            tap(() => {
                this.userSettings.load();
                void this.router.navigate(['/overview']);
            }),
            catchError((err) => {
                const status = err?.status ?? err?.reason?.status;
                if (status === 403) {
                    const {email, password} = this.loginModel();
                    this.emailVerification.show(email, 'none', {email, password});
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


        if(!this.registerForm().valid()) return;

        this.passwordMismatch.set(false);
        this.authService.register(
            this.registerModel().email!,
            this.registerModel().username!,
            this.registerModel().password!,
            this.parseBirthdate(this.registerModel().birthdate!)
        ).pipe(
            tap(() => {
                this.toast.success('Account created!', {detail: 'Welcome to Alpine. You can now sign in.'});
                this.switchToMode(true);
            }),
            catchError((err) => {
                this.toast.httpError('Registration failed', err, {detail: 'Please check your details and try again.'});
                return EMPTY;
            })
        ).subscribe();
    }

    private parseBirthdate(dateStr: string): Date {
        const [day, month, year] = dateStr.split('.').map(Number);
        return new Date(year, month - 1, day);
    }

    public openLink(link: string): void {
        this.externalLinkService.openExternalLink( link);
    }

}
