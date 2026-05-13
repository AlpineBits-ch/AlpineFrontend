import {Component, inject, signal} from '@angular/core';
import {InputText} from "primeng/inputtext";
import {PasswordDirective} from "primeng/password";
import {Button} from "primeng/button";
import {AuthService} from "../../services/auth.service";
import {catchError, EMPTY, tap} from "rxjs";
import {form, FormField} from "@angular/forms/signals";
import {Router} from "@angular/router";
import {NgClass} from "@angular/common";
import {UserSettingsService} from "../../services/user-settings.service";
import {ToastService} from "../../services/toast.service";
import { TranslateModule } from '@ngx-translate/core';


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
  protected authService = inject(AuthService);
  protected router = inject(Router);
  private userSettings = inject(UserSettingsService);
  private toast = inject(ToastService);

  protected loginModel = signal<LoginModel>({email: '', password: ''});
  protected registerModel = signal<RegisterModel>({username: '', email: '', password: '', confirmPassword: '', birthdate: ''});
  protected passwordMismatch = signal(false);

  protected loginForm = form(this.loginModel);
  protected registerForm = form(this.registerModel);

  constructor() {
    this.authService.isLoggedIn().then(r => {
      if(r){
        this.router.navigate(['/overview']);

      }

    });

  }


  protected login(): void {
    this.authService.login(
        this.loginModel().email,
        this.loginModel().password
    ).pipe(
        tap(() => {
          this.userSettings.load();
          this.router.navigate(['/overview']);
        }),
        catchError((err) => {
          this.toast.httpError('Sign in failed', err, { detail: 'Invalid username or password.' });
          return EMPTY;
        })
    ).subscribe();
  }

  private parseBirthdate(dateStr: string): Date {
    const [day, month, year] = dateStr.split('.').map(Number);
    return new Date(year, month - 1, day);
  }

  protected register(): void {
    const model = this.registerModel();
    if (model.password !== model.confirmPassword) {
      this.passwordMismatch.set(true);
      return;
    }
    this.passwordMismatch.set(false);
    this.authService.register(
        this.registerModel().email,
        this.registerModel().username,
        this.registerModel().password,
        this.parseBirthdate(this.registerModel().birthdate)
    ).pipe(
        tap(() => {
          this.toast.success('Account created!', { detail: 'Welcome to Alpine. You can now sign in.' });
          this.isLoginMode.set(true);
        }),
        catchError((err) => {
          this.toast.httpError('Registration failed', err, { detail: 'Please check your details and try again.' });
          return EMPTY;
        })
    ).subscribe();
  }

}
